import { isToolUIPart } from "ai";
import type { PlatypusUIMessage } from "../types.ts";

// why: the stream drops this stamp, but it is the persisted form; live figures ride message metadata
export const applyToolDurations = (
  messages: PlatypusUIMessage[],
  durations: ReadonlyMap<string, number>,
): PlatypusUIMessage[] => {
  if (durations.size === 0) return messages;

  return messages.map((message) => {
    let patched = false;
    const parts = message.parts.map((part) => {
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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set in a callback, which TS narrowing does not track
    return patched ? { ...message, parts } : message;
  });
};
