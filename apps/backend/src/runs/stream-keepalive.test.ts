import { describe, it, expect, afterEach, vi } from "vitest";
import { createUIMessageStreamResponse } from "ai";
import {
  SSE_HEARTBEAT_FRAME,
  withHeartbeatFrames,
  withStreamKeepalive,
} from "./stream-keepalive.ts";

const HEARTBEAT_MS = 50;

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
};

const controllable = () => {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  return {
    stream,
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
};

const heartbeats = (text: string) => text.split(SSE_HEARTBEAT_FRAME).length - 1;

describe("withHeartbeatFrames", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("puts bytes on the wire while the source says nothing", async () => {
    vi.useFakeTimers();
    const source = controllable();
    const kept = withHeartbeatFrames(source.stream, HEARTBEAT_MS);
    const collected = readAll(kept);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    source.end();

    expect(heartbeats(await collected)).toBe(3);
  });

  it("passes the source's own frames through untouched", async () => {
    const source = controllable();
    const kept = withHeartbeatFrames(source.stream, 10_000);
    const collected = readAll(kept);

    source.write('data: {"type":"text-delta","delta":"hi"}\n\n');
    source.write('data: {"type":"finish"}\n\n');
    source.end();

    const text = await collected;
    expect(text).toBe(
      'data: {"type":"text-delta","delta":"hi"}\n\n' +
        'data: {"type":"finish"}\n\n',
    );
    expect(heartbeats(text)).toBe(0);
  });

  it("never splits a source frame", async () => {
    vi.useFakeTimers();
    const source = controllable();
    const kept = withHeartbeatFrames(source.stream, HEARTBEAT_MS);
    const collected = readAll(kept);

    for (let i = 0; i < 3; i++) {
      source.write(`data: {"seq":${i}}\n\n`);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    }
    source.end();

    expect(await collected).toBe(
      `data: {"seq":0}\n\n${SSE_HEARTBEAT_FRAME}` +
        `data: {"seq":1}\n\n${SSE_HEARTBEAT_FRAME}` +
        `data: {"seq":2}\n\n${SSE_HEARTBEAT_FRAME}`,
    );
  });

  it("reads from the source only as the consumer asks for more", async () => {
    const encoder = new TextEncoder();
    let produced = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        if (produced > 100) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: {"n":${produced}}\n\n`));
      },
    });

    const reader = withHeartbeatFrames(source, 10_000).getReader();
    await reader.read();
    await new Promise((r) => setTimeout(r, 0));

    expect(produced).toBeLessThan(10);
    await reader.cancel();
  });

  it("stops beating when the consumer cancels", async () => {
    vi.useFakeTimers();
    const source = controllable();
    const kept = withHeartbeatFrames(source.stream, HEARTBEAT_MS);
    const reader = kept.getReader();

    expect(vi.getTimerCount()).toBe(1);
    await reader.cancel("client gone");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops beating once the source ends", async () => {
    vi.useFakeTimers();
    const source = controllable();
    const kept = withHeartbeatFrames(source.stream, HEARTBEAT_MS);
    const collected = readAll(kept);
    expect(vi.getTimerCount()).toBe(1);
    source.end();
    await collected;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces a source failure to the consumer", async () => {
    const failing = new ReadableStream<Uint8Array>({
      start: (c) => c.error(new Error("upstream died")),
    });

    await expect(
      readAll(withHeartbeatFrames(failing, HEARTBEAT_MS)),
    ).rejects.toThrow("upstream died");
  });
});

describe("withStreamKeepalive", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const streamedRunResponse = () =>
    createUIMessageStreamResponse({
      stream: new ReadableStream({
        start: (c) => c.close(),
      }),
    });

  it("keeps the no-buffering header a reverse proxy reads", () => {
    const kept = withStreamKeepalive(streamedRunResponse(), HEARTBEAT_MS);

    expect(kept.headers.get("x-accel-buffering")).toBe("no");
  });

  it("keeps the event-stream content type and status", () => {
    const kept = withStreamKeepalive(streamedRunResponse(), HEARTBEAT_MS);

    expect(kept.status).toBe(200);
    expect(kept.headers.get("content-type")).toBe("text/event-stream");
  });

  it("returns a bodyless response unchanged rather than rebuilding it", () => {
    const original = new Response(null, { status: 204 });

    expect(withStreamKeepalive(original, HEARTBEAT_MS)).toBe(original);
  });

  it("beats on a real streamed run response that has gone quiet", async () => {
    vi.useFakeTimers();
    let close!: () => void;
    const response = createUIMessageStreamResponse({
      stream: new ReadableStream({
        start: (c) => {
          close = () => c.close();
        },
      }),
    });

    const kept = withStreamKeepalive(response, HEARTBEAT_MS);
    const collected = readAll(kept.body!);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    close();

    expect(heartbeats(await collected)).toBe(2);
  });
});
