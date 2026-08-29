import type { ChatMessageMetadata } from "@platypus/backend/src/types";

export type ResponseMetrics = {
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  prepDurationMs?: number;
  modelDurationMs?: number;
  /** The sum of the turn's locally-executed tool durations, when the message
   *  carries at least one. `0` is a real measurement (a fast tool rounds to
   *  it) and is kept, not treated as absent. */
  measuredToolDurationMs?: number;
};

/**
 * Reads the per-response metrics panel's fields off an assistant message's
 * metadata (issue #354): the turn's billed Token usage and the Preparation /
 * Model phase durations, plus the measured tool time nested under Model.
 *
 * `undefined` when nothing at all is available — the case in which the chat
 * shows no `(i)` control. A message persisted before this change carries none
 * of the new fields and so renders no panel, unless it happens to carry
 * `toolDurations` from #353.
 */
export function responseMetrics(
  metadata: ChatMessageMetadata | undefined,
): ResponseMetrics | undefined {
  const tokenUsage = metadata?.tokenUsage;
  const prepDurationMs = metadata?.prepDurationMs;
  const modelDurationMs = metadata?.modelDurationMs;

  const toolDurations = metadata?.toolDurations;
  const toolDurationValues = toolDurations ? Object.values(toolDurations) : [];
  const measuredToolDurationMs =
    toolDurationValues.length > 0
      ? toolDurationValues.reduce((sum, ms) => sum + ms, 0)
      : undefined;

  if (
    !tokenUsage &&
    prepDurationMs === undefined &&
    modelDurationMs === undefined &&
    measuredToolDurationMs === undefined
  ) {
    return undefined;
  }

  return {
    tokenUsage,
    prepDurationMs,
    modelDurationMs,
    measuredToolDurationMs,
  };
}
