import type { PlatypusUIMessage, TranscriptSummary } from "@platypus/schemas";
import type { Serialized } from "./api-write";

export type ChatTranscriptSummary = Serialized<TranscriptSummary>;

export type UsableTranscriptSummary = {
  summary: ChatTranscriptSummary;
  anchorIndex: number;
};

export function isSummaryUsable(
  summary: Pick<ChatTranscriptSummary, "anchorId" | "coveredIds">,
  messages: readonly PlatypusUIMessage[],
): boolean {
  const anchorIndex = messages.findIndex(
    (message) => message.id === summary.anchorId,
  );
  if (anchorIndex < 0) return false;
  const live = messages.slice(0, anchorIndex + 1).map((message) => message.id);
  if (
    live.length !== summary.coveredIds.length ||
    !live.every((id, index) => id === summary.coveredIds[index])
  ) {
    return false;
  }
  const next = messages[anchorIndex + 1];
  return next === undefined || next.role === "user";
}

export function appliedTranscriptSummary(
  messages: readonly PlatypusUIMessage[],
  summaries: readonly ChatTranscriptSummary[] | undefined,
): UsableTranscriptSummary | undefined {
  if (!summaries?.length) return undefined;
  const index = new Map(messages.map((message, i) => [message.id, i]));
  const usable = summaries
    .filter((summary) => isSummaryUsable(summary, messages))
    .sort(
      (a, b) =>
        index.get(b.anchorId)! - index.get(a.anchorId)! ||
        summaries.indexOf(a) - summaries.indexOf(b),
    );
  const summary = usable[0];
  if (!summary) return undefined;
  return { summary, anchorIndex: index.get(summary.anchorId)! };
}

export function latestReadingSummaryId(
  messages: readonly PlatypusUIMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const metadata = messages[i]?.metadata;
    if (metadata === undefined || !("contextOccupancy" in metadata)) continue;
    return metadata.summaryId;
  }
  return undefined;
}

export function occupancyIsStaleAfterSummary(
  messages: readonly PlatypusUIMessage[],
  summaries: readonly ChatTranscriptSummary[] | undefined,
): boolean {
  const applied = appliedTranscriptSummary(messages, summaries);
  if (!applied) return false;
  return latestReadingSummaryId(messages) !== applied.summary.id;
}

export function summarisingStatusOf(
  messages: readonly PlatypusUIMessage[],
  turnInFlight: boolean,
): string | undefined {
  if (!turnInFlight) return undefined;
  const parts = messages.at(-1)?.parts ?? [];
  for (const part of parts) {
    if (part.type === "data-transcript-summary-status") return part.data.text;
  }
  return undefined;
}
