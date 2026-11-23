import { and, eq, isNull } from "drizzle-orm";
import { cronTriggerConfigSchema } from "@platypus/schemas";
import type { db as appDb } from "../index.ts";
import { trigger as triggerTable } from "./schema.ts";
import { logger } from "../logger.ts";
import { nextCronRunAt } from "../utils/cron.ts";

type Executor = Pick<typeof appDb, "select" | "update">;

// why: TS, not SQL; the next run is a cron in the Trigger's own timezone
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
      // why: rechecked at write time, so a claim that won meanwhile is not undone
      .where(and(eq(triggerTable.id, job.id), isNull(triggerTable.nextRunAt)));
    scheduled++;
  }

  return { scheduled, skipped };
};
