/**
 * Formats how long a tool call took, adapting the unit to the magnitude so the
 * number stays readable at a glance: `<1ms`, `842ms`, `1.2s`, `1m 03s`.
 *
 * The stored figure is whole milliseconds, and plenty of local tools finish
 * inside one — a third of the calls on a real chat round to zero. Those read as
 * `<1ms`, because a bare `0ms` looks like a field that failed to populate.
 */
export function formatToolDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  return `${Math.floor(totalSeconds / 60)}m ${String(seconds).padStart(2, "0")}s`;
}

/** Reads a numeric property off a value that may be anything at all. */
const numberAt = (source: unknown, key: string): number | undefined => {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
};

/**
 * Pulls the run pipeline's recorded duration out of a tool invocation's
 * `toolMetadata`. The field is a free-form JSON object a provider may also
 * write to, so the value is checked rather than cast: anything that isn't a
 * number reads as "no duration", which renders as nothing at all.
 */
export function toolDurationMs(metadata: unknown): number | undefined {
  return numberAt(metadata, "durationMs");
}

/**
 * How long a tool call took, from whichever of the two carriers has it.
 *
 * The part's own `toolMetadata` is the record and is preferred; the message's
 * `toolDurations` map is how the figure arrives mid-turn, because the AI SDK's
 * tool reducer rebuilds each tool part from its stored invocation and discards
 * metadata the output chunk carried. So during the turn that produced it only
 * the map has it, and after a reload the part does — the same number either way,
 * which is why there is no visible change when one takes over from the other.
 *
 * Messages written before both carriers existed have neither and render no time,
 * which is the documented behaviour for older Chats.
 */
export function toolCallDurationMs(
  toolMetadata: unknown,
  messageMetadata: unknown,
  toolCallId: string,
): number | undefined {
  const fromPart = toolDurationMs(toolMetadata);
  if (fromPart !== undefined) return fromPart;
  if (typeof messageMetadata !== "object" || messageMetadata === null) {
    return undefined;
  }
  return numberAt(
    (messageMetadata as Record<string, unknown>).toolDurations,
    toolCallId,
  );
}
