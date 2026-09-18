import { describe, expect, it } from "vitest";
import { readUIMessageStream } from "ai";
import type { InferUIMessageChunk } from "ai";

import { replaySeededParts } from "./replay-seeded-parts.ts";
import type { PlatypusUIMessage } from "../types.ts";

type Chunk = InferUIMessageChunk<PlatypusUIMessage>;

const seededMessage: PlatypusUIMessage = {
  id: "msg-seed",
  role: "assistant",
  parts: [
    {
      type: "tool-loadSkill",
      toolCallId: "call-1",
      state: "output-available",
      input: { name: "blog-post" },
      output: { name: "blog-post", body: "Write a blog post." },
    },
  ],
};

const user: PlatypusUIMessage = {
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "/blog-post about otters" }],
};

/** What `toUIMessageStream` emits for a one-step reply, ids already injected. */
const modelChunks: Chunk[] = [
  { type: "start", messageId: "msg-seed" },
  { type: "start-step" },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "Here you go." },
  { type: "text-end", id: "t1" },
  { type: "finish-step" },
  { type: "finish" },
];

const through = (
  original: PlatypusUIMessage[],
  chunks: Chunk[] = modelChunks,
): ReadableStream<Chunk> =>
  new ReadableStream<Chunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }).pipeThrough(replaySeededParts(original));

/** The message a downstream consumer folds out of the stream. */
const fold = async (stream: ReadableStream<Chunk>) => {
  let last: PlatypusUIMessage | undefined;
  for await (const message of readUIMessageStream<PlatypusUIMessage>({
    stream,
  })) {
    last = message;
  }
  return last;
};

describe("replaySeededParts", () => {
  it("rebuilds a continued message's tool part for a consumer that never held it", async () => {
    const folded = await fold(through([user, seededMessage]));

    expect(folded?.id).toBe("msg-seed");
    // The card comes first, then the reply — one message, in reading order.
    expect(folded?.parts[0]).toMatchObject({
      type: "tool-loadSkill",
      toolCallId: "call-1",
      state: "output-available",
      input: { name: "blog-post" },
      output: { name: "blog-post", body: "Write a blog post." },
    });
    expect(folded?.parts.at(-1)).toMatchObject({
      type: "text",
      text: "Here you go.",
    });
  });

  it("replays nothing when the turn opens no continued message", async () => {
    const folded = await fold(through([user]));

    expect(folded?.parts.some((part) => part.type === "tool-loadSkill")).toBe(
      false,
    );
    expect(folded?.parts.at(-1)).toMatchObject({ text: "Here you go." });
  });

  it("replays a part once, however many steps the reply takes", async () => {
    const twoSteps: Chunk[] = [
      { type: "start", messageId: "msg-seed" },
      { type: "start-step" },
      { type: "finish-step" },
      { type: "start-step" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Done." },
      { type: "text-end", id: "t1" },
      { type: "finish-step" },
      { type: "finish" },
    ];
    const folded = await fold(through([user, seededMessage], twoSteps));

    expect(
      folded?.parts.filter((part) => part.type === "tool-loadSkill"),
    ).toHaveLength(1);
  });

  it("leaves a part it cannot express alone rather than half-replaying it", async () => {
    const pending: PlatypusUIMessage = {
      id: "msg-seed",
      role: "assistant",
      parts: [
        {
          type: "tool-loadSkill",
          toolCallId: "call-1",
          state: "input-available",
          input: { name: "blog-post" },
        },
      ],
    };
    const folded = await fold(through([user, pending]));

    expect(folded?.parts.some((part) => part.type === "tool-loadSkill")).toBe(
      false,
    );
  });
});
