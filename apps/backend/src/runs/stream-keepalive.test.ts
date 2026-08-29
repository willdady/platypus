import { describe, it, expect, afterEach, vi } from "vitest";
import { createUIMessageStreamResponse } from "ai";
import {
  SSE_HEARTBEAT_FRAME,
  withHeartbeatFrames,
  withStreamKeepalive,
} from "./stream-keepalive.ts";

const HEARTBEAT_MS = 50;

/** Reads a byte stream to the end and returns it as one decoded string. */
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

/** A byte stream the test pushes to and ends by hand. */
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

    // Nothing from the model for several heartbeat intervals — the case a
    // proxy's idle timeout would otherwise kill. Advanced asynchronously so the
    // reader gets a turn to drain each heartbeat before the next fires.
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

  // A heartbeat frame inside another frame would corrupt the event the client
  // is parsing, so they may only ever land on a frame boundary.
  it("never splits a source frame", async () => {
    const source = controllable();
    const kept = withHeartbeatFrames(source.stream, HEARTBEAT_MS);
    const collected = readAll(kept);

    for (let i = 0; i < 4; i++) {
      source.write(`data: {"seq":${i}}\n\n`);
      await new Promise((r) => setTimeout(r, HEARTBEAT_MS + 5));
    }
    source.end();

    const text = await collected;
    expect(heartbeats(text)).toBeGreaterThanOrEqual(3);
    for (const frame of text.split("\n\n").filter(Boolean)) {
      expect(
        frame === ": heartbeat" || /^data: \{"seq":\d\}$/.test(frame),
      ).toBe(true);
    }
  });

  // Wrapping must not turn the run into a buffer on a slow client's behalf. A
  // wrapper that pumped the source from `start` would drain all 100 chunks into
  // memory after a single read.
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
    await new Promise((r) => setTimeout(r, 30));

    expect(produced).toBeLessThan(10);
    await reader.cancel();
  });

  // The interval outlives the request otherwise: a client that navigates away
  // cancels the response body, and a timer still enqueueing into it leaks for
  // the life of the process.
  it("stops beating when the consumer cancels", async () => {
    vi.useFakeTimers();
    const source = controllable();
    const kept = withHeartbeatFrames(source.stream, HEARTBEAT_MS);
    const reader = kept.getReader();

    await reader.cancel("client gone");
    vi.advanceTimersByTime(HEARTBEAT_MS * 10);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops beating once the source ends", async () => {
    const source = controllable();
    const kept = withHeartbeatFrames(source.stream, HEARTBEAT_MS);
    const collected = readAll(kept);
    source.end();
    await collected;

    vi.useFakeTimers();
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

  /** The response shape the runner hands over, built the way the SDK builds it. */
  const streamedRunResponse = () =>
    createUIMessageStreamResponse({
      stream: new ReadableStream({
        start: (c) => c.close(),
      }),
    });

  // The other half of surviving an intermediary: a proxy that buffers a
  // streamed response holds every heartbeat back until the run ends, which
  // defeats the point of sending them.
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
