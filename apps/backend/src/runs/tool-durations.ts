import { isToolUIPart } from "ai";
import type { PlatypusUIMessage } from "../types.ts";

/**
 * Folds recorded tool execution times into the run's final messages — the copy
 * the sink persists, and therefore what a later reload reads.
 *
 * This is the stamp of record, but it is not how the figure reaches the browser.
 * Nothing can put a measured duration on the tool part while streaming: the UI
 * message stream's `tool-output-available` reducer rebuilds the part from the
 * *stored* invocation and passes `toolMetadata: toolInvocation.toolMetadata`,
 * discarding whatever the output chunk carried (verified in `ai@7.0.48`, and the
 * same gotcha #353 recorded against `ai@6.x`). Writing it on
 * `tool-input-available`, which the reducer does read, is no good either — the
 * tool has not run yet.
 *
 * So the live figure travels as message metadata instead, keyed by
 * `toolCallId` (see `createMessageMetadata`), and this stamp keeps the per-part
 * form that every message persisted so far already uses. The frontend reads the
 * part first and falls back to the metadata.
 *
 * Durations are keyed by `toolCallId`, which both static (`tool-*`) and dynamic
 * tool parts carry. Existing metadata is merged, not replaced — the field is
 * provider-populated in principle even though nothing else sets it today.
 *
 * The SDK measures on a high-resolution clock and reports figures like
 * `706.9857919998467`. Nothing reads below a millisecond, so the value is
 * rounded before it goes into the message rather than storing sixteen
 * significant digits per tool call for the lifetime of the chat.
 */
export const applyToolDurations = (
  messages: PlatypusUIMessage[],
  durations: ReadonlyMap<string, number>,
): PlatypusUIMessage[] => {
  if (durations.size === 0) return messages;

  return messages.map((message) => {
    let patched = false;
    const parts = message.parts.map((part) => {
      // Covers both static (`tool-*`) and dynamic tool invocations.
      if (!isToolUIPart(part)) return part;
      const durationMs = durations.get(part.toolCallId);
      if (durationMs === undefined) return part;
      patched = true;
      return {
        ...part,
        toolMetadata: {
          ...part.toolMetadata,
          durationMs: Math.round(durationMs),
        },
      };
    });
    return patched ? { ...message, parts } : message;
  });
};
