export function formatToolDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  return `${Math.floor(totalSeconds / 60)}m ${String(seconds).padStart(2, "0")}s`;
}

export function toolCallDurationMs(
  toolMetadata: unknown,
  messageMetadata: unknown,
  toolCallId: string,
): number | undefined {
  const partDuration = (toolMetadata as { durationMs?: unknown } | null)
    ?.durationMs;
  const mapDuration = (
    messageMetadata as { toolDurations?: Record<string, unknown> } | null
  )?.toolDurations?.[toolCallId];

  const duration =
    (typeof partDuration === "number" ? partDuration : undefined) ??
    mapDuration;
  return typeof duration === "number" ? duration : undefined;
}
