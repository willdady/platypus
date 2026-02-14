import { sql } from "drizzle-orm";
import { db } from "../index.ts";
import { processMemoryExtractionBatch } from "../services/memory-extraction.ts";
import { logger } from "../logger.ts";

const MEMORY_EXTRACTION_INTERVAL_MS = parseInt(
  process.env.MEMORY_EXTRACTION_INTERVAL_MS || "300000", // 5 minutes
);

// Advisory lock ID for memory extraction (arbitrary unique number)
const MEMORY_EXTRACTION_LOCK_ID = 123456789;

async function runWithLock(fn: () => Promise<void>): Promise<void> {
  // Try to acquire advisory lock (non-blocking)
  const lockResult = await db.execute(
    sql`SELECT pg_try_advisory_lock(${MEMORY_EXTRACTION_LOCK_ID}) as acquired`,
  );

  const acquired = lockResult.rows[0]?.acquired;

  if (!acquired) {
    logger.debug(
      "Another backend instance is processing memories, skipping this run",
    );
    return;
  }

  try {
    await fn();
  } finally {
    // Always release lock, even if processing fails
    await db.execute(
      sql`SELECT pg_advisory_unlock(${MEMORY_EXTRACTION_LOCK_ID})`,
    );
  }
}

/**
 * Schedules a function to run at wall-clock-aligned intervals.
 *
 * Unlike setInterval (which starts from the moment the process boots),
 * this aligns execution to absolute clock boundaries. For example, with
 * a 5-minute interval, all instances will attempt to run at :00, :05,
 * :10, :15, etc. regardless of when they started.
 *
 * This is critical for horizontal scaling: all backend instances align
 * to the same schedule, so the advisory lock contention is predictable
 * and only one instance wins each cycle.
 */
function scheduleAligned(intervalMs: number, fn: () => Promise<void>): void {
  function scheduleNext() {
    const now = Date.now();
    const nextTick = Math.ceil(now / intervalMs) * intervalMs;
    const delay = nextTick - now;

    setTimeout(async () => {
      try {
        await fn();
      } catch (error) {
        logger.error({ error }, "Scheduled job failed");
      }
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

export function startScheduler() {
  logger.info(
    `Starting memory extraction scheduler (interval: ${MEMORY_EXTRACTION_INTERVAL_MS}ms, wall-clock aligned)`,
  );

  // Schedule at wall-clock-aligned intervals with advisory lock
  scheduleAligned(MEMORY_EXTRACTION_INTERVAL_MS, async () => {
    await runWithLock(async () => {
      await processMemoryExtractionBatch();
    });
  });
}
