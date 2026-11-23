import { getStaticToolName, isStaticToolUIPart } from "ai";
import type { InferUIMessageChunk } from "ai";
import type { PlatypusUIMessage } from "../types.ts";

type Chunk = InferUIMessageChunk<PlatypusUIMessage>;

export const replaySeededParts = (
  originalMessages: PlatypusUIMessage[],
): TransformStream<Chunk, Chunk> => {
  const continued = originalMessages.at(-1);
  const replay =
    continued?.role === "assistant"
      ? continued.parts.flatMap(replayChunksFor)
      : [];

  let replayed = replay.length === 0;

  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (!replayed && chunk.type === "start") {
        replayed = true;
        for (const seeded of replay) controller.enqueue(seeded);
      }
    },
  });
};

const replayChunksFor = (part: PlatypusUIMessage["parts"][number]): Chunk[] => {
  if (!isStaticToolUIPart(part) || part.state !== "output-available") return [];
  return [
    {
      type: "tool-input-available",
      toolCallId: part.toolCallId,
      toolName: getStaticToolName(part),
      input: part.input,
    },
    {
      type: "tool-output-available",
      toolCallId: part.toolCallId,
      output: part.output,
    },
  ] as Chunk[];
};
