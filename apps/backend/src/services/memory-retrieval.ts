import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../index.ts";
import { memoryDailySummary as memoryDailySummaryTable } from "../db/schema.ts";

export type MemorySummary = typeof memoryDailySummaryTable.$inferSelect;

/**
 * How many days of daily summaries the Memories fragment carries. A named
 * concept rather than a literal at each call site: every caller wants the same
 * window, and the one place it could differ — a caller passing its own `days` —
 * would silently change what a Chat recalls.
 */
export const MEMORY_SUMMARY_WINDOW_DAYS = 2;

/**
 * The `YYYY-MM-DD` cutoff a retrieval window starts at, anchored to
 * `referenceDate` and spanning `days` back. Extracted from the query so the
 * "window is an input, not a clock read" property (ADR-0020) is unit-testable:
 * the retrieval anchors to the caller's moment, never to a render-time clock.
 */
export function summaryCutoffForReference(
  referenceDate: Date,
  days: number,
): string {
  const cutoffDate = new Date(referenceDate);
  cutoffDate.setDate(cutoffDate.getDate() - days);
  return cutoffDate.toISOString().split("T")[0];
}

/**
 * Retrieves the most recent daily summaries for a user in a workspace.
 *
 * The window is {@link MEMORY_SUMMARY_WINDOW_DAYS} and is anchored to the passed
 * `referenceDate`, never to a wall-clock read at render time (ADR-0020): a
 * cutoff computed from the clock made every Chat's prefix differ by the moment
 * of composition and rolled all of them over at midnight. The caller bounds its
 * own freshness — the Chat route passes the pin's re-take time, a headless run
 * passes its resolution time — and the renderer never reads the clock at all.
 * `referenceDate` is required so no caller silently inherits a hidden clock
 * read. The window itself is not a parameter: no caller varies it, and one that
 * did would quietly change what a Chat recalls.
 */
export async function retrieveRecentSummaries(
  userId: string,
  workspaceId: string,
  referenceDate: Date,
): Promise<MemorySummary[]> {
  const cutoffDateStr = summaryCutoffForReference(
    referenceDate,
    MEMORY_SUMMARY_WINDOW_DAYS,
  );

  return db
    .select()
    .from(memoryDailySummaryTable)
    .where(
      and(
        eq(memoryDailySummaryTable.userId, userId),
        eq(memoryDailySummaryTable.workspaceId, workspaceId),
        sql`${memoryDailySummaryTable.summaryDate} >= ${cutoffDateStr}`,
      ),
    )
    .orderBy(desc(memoryDailySummaryTable.summaryDate));
}

/**
 * Formats daily summaries for injection into the system prompt.
 */
export function formatSummariesForSystemPrompt(
  summaries: MemorySummary[],
): string {
  const withContent = summaries.filter((s) => s.summary.trim());
  if (withContent.length === 0) {
    return "";
  }

  const parts = ["Recent memory summaries from previous conversations:", ""];

  for (const summary of withContent) {
    parts.push(`### ${summary.summaryDate}`);
    parts.push(summary.summary);
    parts.push("");
  }

  return parts.join("\n").trim();
}

/**
 * The re-pin horizon (ADR-0020): the longest cache TTL any supported Provider
 * offers. Past this the cached prefix is provably expired, so re-taking the
 * Memories snapshot is free. The measure is the Chat's **idle gap** — the
 * elapsed time since the previous turn — never the snapshot's own age: a Chat
 * in continuous use genuinely holds a warm prefix regardless of how old its
 * snapped block is, and re-pinning on snapshot age would discard it for no gain
 * (the two measures only agree once a Chat has actually gone cold).
 */
export const MEMORY_SNAPSHOT_RE_PIN_HORIZON_MS = 60 * 60 * 1000;

/**
 * What a Chat turn does about its pinned Memories block. `reuse: true` carries
 * the block to render, so a caller cannot reach for a snapshot the decision did
 * not actually hand it: reuse and the reused text are one value, not a boolean
 * plus a non-null assertion about a rule enforced in another module.
 */
export type MemoryPinDecision =
  { reuse: false } | { reuse: true; block: string };

/**
 * Decides whether a Chat reuses its pinned Memories block this turn, and hands
 * back the block when it does.
 *
 * Re-takes when there is no pin at all (`null`/`undefined` — a new Chat, or a
 * row written before this feature existed), when there is no recorded previous
 * turn to measure idleness against, or when the gap since the previous turn
 * exceeds the re-pin horizon. Otherwise the existing pin is reused so the
 * system-prompt prefix stays byte-identical across turns of an active Chat —
 * the property ADR-0020 exists to preserve.
 *
 * An empty string is a *pinned* empty block, not an absent one: a Chat with no
 * memories still pins a stable (empty) prefix, so it must not re-retrieve every
 * turn. The absence signal is `null`/`undefined` only.
 */
export function resolveMemoryPin(args: {
  existingSnapshot: string | null | undefined;
  previousTurnAt: Date | null | undefined;
  now: Date;
}): MemoryPinDecision {
  if (args.existingSnapshot == null) return { reuse: false };
  if (!args.previousTurnAt) return { reuse: false };
  const idleGapMs = args.now.getTime() - args.previousTurnAt.getTime();
  if (idleGapMs > MEMORY_SNAPSHOT_RE_PIN_HORIZON_MS) return { reuse: false };
  return { reuse: true, block: args.existingSnapshot };
}
