import type { PlatypusUIMessage, TranscriptSummary } from "@platypus/schemas";
import type { Serialized } from "./api-write";

/**
 * A Transcript summary as the API returns it to the frontend: `createdAt` is
 * the wire string (`Serialized`), not the row's `Date`. Nothing here reads the
 * timestamp — the read-time usability check uses the anchor and the covered
 * ids — so the display type is all the Chat holds.
 */
export type ChatTranscriptSummary = Serialized<TranscriptSummary>;

/**
 * A **Transcript summary** as the Chat renders it (ADR-0041, issue #1716).
 *
 * The read-time usability check is the same one the backend applies before it
 * sends a summary (`applyTranscriptSummary`), restated here because the
 * frontend must not compile backend source: a summary is usable when its
 * anchor is on the current Active path, its `coveredIds` are exactly the live
 * path ids from the root through that anchor, and the anchor still ends a turn
 * (the message after it, if any, is the user message that carries it). A
 * Delete inside the range — or of that first kept user message — makes it
 * unusable, and the divider must not render for it.
 */

export type UsableTranscriptSummary = {
  summary: ChatTranscriptSummary;
  /** Index in `messages` of the anchor message the divider sits after. */
  anchorIndex: number;
};

/** Whether `summary` reads correctly on the current Active path. */
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
  // The anchor must still end a turn: the summary rides the first kept user
  // message. An anchor at the leaf (a `/compact`, issue #1111) has none yet,
  // but the next message sent is one, so it is what the next turn reads.
  const next = messages[anchorIndex + 1];
  return next === undefined || next.role === "user";
}

/**
 * The summary the Chat actually reads: the deepest usable one, newest first at
 * the same anchor (`summaries` arrives newest-first from the API). Only this
 * one gets a divider — an older, superseded summary is not what the assistant
 * reads, so a divider claiming it were would be false.
 */
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

/**
 * The summary id the newest Context occupancy reading was taken through — the
 * metadata the backend stamps beside each reading (ADR-0041), or `undefined`
 * for a turn that ran with no summary.
 */
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

/**
 * Whether the composer's meter should read "—" rather than a number (ADR-0041).
 *
 * True once a summary is in place that the last reading predates: the reading
 * measured the view BEFORE the summary, so re-showing it would claim a size the
 * next call no longer starts at. It clears when the next turn reports a reading
 * taken through the same summary. A summary taken but not usable on the current
 * path changes nothing, because the next turn still sends the old view.
 */
export function occupancyIsStaleAfterSummary(
  messages: readonly PlatypusUIMessage[],
  summaries: readonly ChatTranscriptSummary[] | undefined,
): boolean {
  const applied = appliedTranscriptSummary(messages, summaries);
  if (!applied) return false;
  return latestReadingSummaryId(messages) !== applied.summary.id;
}

/**
 * The "Summarising earlier messages…" status this turn has streamed, if any
 * (ADR-0041). The backend emits it as a Run event at the head of a turn that
 * waited for a summary, so the Chat reads it off the streamed message rather
 * than being told about the wait some other way. Absent once the turn is over:
 * the status is about a wait in progress, not a fact about the reply.
 */
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
