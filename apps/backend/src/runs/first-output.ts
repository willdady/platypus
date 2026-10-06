import type { InferUIMessageChunk } from "ai";
import type { PlatypusUIMessage } from "../types.ts";

/**
 * A run's first output: the moment the model first puts something on its
 * reply — a text, a reasoning or a tool call. The Chat sink saves the reply
 * then, rather than at the end of the step, so a reader can tell a run that
 * is answering from one still waiting on its model (#1337).
 *
 * Only what comes after the first step starts counts: a `/skill` turn's seeded
 * card is replayed onto the stream before it (`replay-seeded-parts.ts`), and
 * is not the model's.
 */

type Chunk = InferUIMessageChunk<PlatypusUIMessage>;

/** The UI stream chunks that put output on the reply. */
const OUTPUT_CHUNKS = new Set([
  "text-start",
  "text-delta",
  "reasoning-start",
  "reasoning-delta",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-available",
]);

/** Whether a reply part is output: what an output chunk folds into. */
const isOutputPart = (part: PlatypusUIMessage["parts"][number]): boolean =>
  part.type === "text" ||
  part.type === "reasoning" ||
  part.type === "dynamic-tool" ||
  part.type.startsWith("tool-");

/**
 * Whether a folded reply has output past its first step's start. True from
 * the snapshot the first output chunk folds into, so a stream held by
 * `holdFirstOutput` is let go once the sink has saved it.
 */
export const hasOutput = (reply: PlatypusUIMessage): boolean => {
  const started = reply.parts.findIndex((part) => part.type === "step-start");
  return (
    reply.role === "assistant" &&
    started !== -1 &&
    reply.parts.slice(started + 1).some(isOutputPart)
  );
};

/**
 * A latch over a run's UI stream: answers true for its first output chunk,
 * and false for every chunk before and after it.
 */
export const firstOutputLatch = (): ((chunk: { type: string }) => boolean) => {
  let stepStarted = false;
  let seen = false;
  return (chunk) => {
    if (chunk.type === "start-step") stepStarted = true;
    if (seen || !stepStarted || !OUTPUT_CHUNKS.has(chunk.type)) return false;
    seen = true;
    return true;
  };
};

/**
 * Holds the stream's first output chunk until `saved` settles, so whoever
 * reads it finds the reply already saved. Every other chunk passes straight
 * through.
 */
export const holdFirstOutput = (
  saved: Promise<unknown>,
): TransformStream<Chunk, Chunk> => {
  const isFirstOutput = firstOutputLatch();
  return new TransformStream({
    async transform(chunk, controller) {
      if (isFirstOutput(chunk)) await saved;
      controller.enqueue(chunk);
    },
  });
};
