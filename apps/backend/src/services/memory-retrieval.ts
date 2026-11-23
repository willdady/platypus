import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../index.ts";
import { memoryDailySummary as memoryDailySummaryTable } from "../db/schema.ts";

export type MemorySummary = Pick<
  typeof memoryDailySummaryTable.$inferSelect,
  "summaryDate" | "summary"
>;

export const MEMORY_SUMMARY_WINDOW_DAYS = 2;

export function summaryCutoffForReference(
  referenceDate: Date,
  days: number,
): string {
  const cutoffDate = new Date(referenceDate);
  cutoffDate.setDate(cutoffDate.getDate() - days);
  return cutoffDate.toISOString().slice(0, 10);
}

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
    .select({
      summaryDate: memoryDailySummaryTable.summaryDate,
      summary: memoryDailySummaryTable.summary,
    })
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

export const MEMORY_SNAPSHOT_RE_PIN_HORIZON_MS = 60 * 60 * 1000;

export type MemoryPinDecision =
  { reuse: false } | { reuse: true; block: string };

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
