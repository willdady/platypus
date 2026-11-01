import { and, eq, isNull } from "drizzle-orm";
import { cronTriggerConfigSchema } from "@platypus/schemas";
import type { db as appDb } from "../index.ts";
import { trigger as triggerTable } from "./schema.ts";
import { logger } from "../logger.ts";
import { nextCronRunAt } from "../utils/cron.ts";

/**
 * Anything that can read and write a table — `db` or a transaction.
 * Structural, so the migration script can hand in the pool it opened.
 */
type Executor = Pick<typeof appDb, "select" | "update">;

/**
 * Puts every enabled Cron Trigger left with no `next_run_at` back on its
 * schedule (v4).
 *
 * Before v4 a claim wrote `NULL` rather than the next slot, and a runtime
 * sweep repaired the stranded rows on every tick. That sweep is gone; this is
 * the one-off that replaces it, run by `scripts/migrate.ts` straight after the
 * schema migrations. It has to be TypeScript: the next run is a cron
 * expression evaluated in the Trigger's own timezone, which Postgres cannot
 * do, and `next_run_at = now()` would fire the Trigger once at an hour nobody
 * asked for.
 *
 * An enabled One-off with no schedule is scheduled too: it never fired (a
 * firing disables it), so this is the run it was waiting for.
 *
 * Scoped to rows that are still stranded, so running it on a database that
 * needs nothing is a single `SELECT` that finds no rows.
 */
export const backfillTriggerNextRunAt = async (
  database: Executor,
  now: Date = new Date(),
): Promise<{ scheduled: number; skipped: number }> => {
  const stranded = await database
    .select({
      id: triggerTable.id,
      name: triggerTable.name,
      config: triggerTable.config,
    })
    .from(triggerTable)
    .where(
      and(
        eq(triggerTable.type, "cron"),
        eq(triggerTable.enabled, true),
        isNull(triggerTable.nextRunAt),
      ),
    );

  let scheduled = 0;
  let skipped = 0;

  for (const job of stranded) {
    const parsed = cronTriggerConfigSchema.safeParse(job.config);
    const nextRunAt = parsed.success ? nextCronRunAt(parsed.data) : null;
    if (!nextRunAt) {
      skipped++;
      logger.error(
        { triggerId: job.id, name: job.name, config: job.config },
        "Cannot schedule a stranded Trigger: its cron config is invalid",
      );
      continue;
    }

    await database
      .update(triggerTable)
      .set({ nextRunAt, updatedAt: now })
      // Rechecked at write time, so a claim that won meanwhile is not undone.
      .where(and(eq(triggerTable.id, job.id), isNull(triggerTable.nextRunAt)));
    scheduled++;
  }

  return { scheduled, skipped };
};
