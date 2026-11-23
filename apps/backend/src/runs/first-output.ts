import type { InferUIMessageChunk } from "ai";
import type { PlatypusUIMessage } from "../types.ts";

type Chunk = InferUIMessageChunk<PlatypusUIMessage>;

const OUTPUT_CHUNKS = new Set([
  "text-start",
  "text-delta",
  "reasoning-start",
  "reasoning-delta",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-available",
]);

const isOutputPart = (part: PlatypusUIMessage["parts"][number]): boolean =>
  part.type === "text" ||
  part.type === "reasoning" ||
  part.type === "dynamic-tool" ||
  part.type.startsWith("tool-");

export const hasOutput = (reply: PlatypusUIMessage): boolean => {
  const started = reply.parts.findIndex((part) => part.type === "step-start");
  return (
    reply.role === "assistant" &&
    started !== -1 &&
    reply.parts.slice(started + 1).some(isOutputPart)
  );
};

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
