import { describe, it, expect } from "vitest";
import { readUIMessageStream, type InferUIMessageChunk } from "ai";
import type { PlatypusUIMessage } from "../types.ts";
import {
  firstOutputLatch,
  hasOutput,
  holdFirstOutput,
} from "./first-output.ts";

type Chunk = InferUIMessageChunk<PlatypusUIMessage>;

const streamOf = (chunks: Chunk[]) =>
  new ReadableStream<Chunk>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  });

/** Each reply `chunks` fold into, in turn, as the runner's drain sees them. */
const folds = async (chunks: Chunk[]) => {
  const out: PlatypusUIMessage[] = [];
  for await (const message of readUIMessageStream<PlatypusUIMessage>({
    stream: streamOf(chunks),
  })) {
    out.push(structuredClone(message));
  }
  return out;
};

const begun: Chunk[] = [
  { type: "start", messageId: "r1" },
  { type: "start-step" },
];

/** A `/skill` turn's seeded card, as `replaySeededParts` puts it back. */
const seeded: Chunk[] = [
  { type: "start", messageId: "r1" },
  {
    type: "tool-input-available",
    toolCallId: "seed-1",
    toolName: "loadSkill",
    input: {},
  },
  { type: "tool-output-available", toolCallId: "seed-1", output: {} },
  { type: "start-step" },
];

describe("the first output", () => {
  // Each chunk that can open a reply's output, after the step's start.
  const openers: Chunk[] = [
    { type: "text-start", id: "t1" },
    { type: "reasoning-start", id: "r1" },
    { type: "tool-input-start", toolCallId: "c1", toolName: "memorySearch" },
    {
      type: "tool-input-available",
      toolCallId: "c1",
      toolName: "memorySearch",
      input: {},
    },
  ];

  it.each(openers)(
    "is the chunk the reply's output first folds from: $type",
    async (opener) => {
      const chunks = [...begun, opener];
      const isFirstOutput = firstOutputLatch();

      expect(chunks.map(isFirstOutput)).toEqual([false, false, true]);
      const replies = await folds(chunks);
      expect(replies.slice(0, -1).some(hasOutput)).toBe(false);
      expect(replies.at(-1)!).toSatisfy(hasOutput);
    },
  );

  it("is not a step started with nothing in it yet", async () => {
    expect((await folds(begun)).some(hasOutput)).toBe(false);
  });

  it("is not a /skill turn's seeded card", async () => {
    const isFirstOutput = firstOutputLatch();

    expect(seeded.map(isFirstOutput).some(Boolean)).toBe(false);
    expect((await folds(seeded)).some(hasOutput)).toBe(false);
  });

  it("is the model's first words after a seeded card", async () => {
    const chunks: Chunk[] = [...seeded, { type: "text-start", id: "t1" }];
    const isFirstOutput = firstOutputLatch();

    expect(chunks.map(isFirstOutput).indexOf(true)).toBe(chunks.length - 1);
    expect((await folds(chunks)).at(-1)!).toSatisfy(hasOutput);
  });

  it("is seen once", () => {
    const isFirstOutput = firstOutputLatch();
    const chunks: Chunk[] = [
      ...begun,
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Hi" },
      { type: "start-step" },
      { type: "text-start", id: "t2" },
    ];

    expect(chunks.map(isFirstOutput).filter(Boolean)).toHaveLength(1);
  });
});

describe("holdFirstOutput", () => {
  it("holds the first output chunk until the reply is saved, and no other", async () => {
    let save = () => {};
    const saved = new Promise<void>((resolve) => (save = resolve));
    const reader = streamOf([
      ...begun,
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Hi" },
    ])
      .pipeThrough(holdFirstOutput(saved))
      .getReader();

    expect((await reader.read()).value?.type).toBe("start");
    expect((await reader.read()).value?.type).toBe("start-step");
    let released = false;
    const next = reader.read().then((read) => {
      released = true;
      return read;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(released).toBe(false);

    save();
    expect((await next).value?.type).toBe("text-start");
    expect((await reader.read()).value?.type).toBe("text-delta");
    expect((await reader.read()).done).toBe(true);
  });
});
