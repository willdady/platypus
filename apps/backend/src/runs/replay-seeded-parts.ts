import { getStaticToolName, isStaticToolUIPart } from "ai";
import type { InferUIMessageChunk } from "ai";
import type { PlatypusUIMessage } from "../types.ts";

type Chunk = InferUIMessageChunk<PlatypusUIMessage>;

/**
 * Re-emits a continued assistant message's settled Tool parts onto the front of
 * the UI stream.
 *
 * `toUIMessageStream` treats a trailing assistant message as a continuation and
 * reuses its id, but it never re-emits that message's existing parts. Its own
 * terminal fold does not need them — that fold's state is seeded from the
 * message itself. `drive.ts` seeds its own snapshot reader the same way. The
 * browser never held a seeded message at all: a user-invoked Skill's
 * `loadSkill` pair is built server-side (issue #649), so the live turn
 * rendered the reply with no card above it, and the card only appeared on a
 * reload. A reply resumed after its approvals were answered is one the
 * browser already holds, and a replayed part lands on its own by id.
 *
 * Replaying puts the browser on the same footing as the fold. Nothing is duplicated:
 * these chunks are appended after `toUIMessageStream` has returned, so the SDK's
 * fold never sees them.
 *
 * Only settled static Tool parts are replayed, because that is the whole of
 * what seeding produces — a `loadSkill` call and its result. A part this cannot
 * express would be dropped silently, so anything seeded in future belongs here
 * too.
 */
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
      // Immediately after `start` — which carries the continued message's id —
      // and so before the model's first `start-step`. That ordering is what
      // puts the card above the reply rather than in the middle of it.
      if (!replayed && chunk.type === "start") {
        replayed = true;
        for (const seeded of replay) controller.enqueue(seeded);
      }
    },
  });
};

/** The `input-available` / `output-available` pair that rebuilds one Tool part. */
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
