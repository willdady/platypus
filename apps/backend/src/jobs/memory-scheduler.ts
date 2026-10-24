import { processMemoryExtractionBatch } from "../services/memory-extraction.ts";
import { logger } from "../logger.ts";
import { db } from "../index.ts";
import { ADVISORY_LOCK_IDS, withAdvisoryLock } from "../db/advisory-lock.ts";
import { scheduleAligned } from "./scheduler.ts";
import { env } from "../env.ts";

/**
 * Starts memory extraction on its interval. The stop handle also aborts a
 * batch in progress, which stops at the Chat it is on.
 */
export function startMemoryScheduler(): () => void {
  const { MEMORY_EXTRACTION_INTERVAL_MS } = env();
  logger.info(
    `Starting memory extraction scheduler (interval: ${MEMORY_EXTRACTION_INTERVAL_MS}ms, wall-clock aligned)`,
  );

  const stopping = new AbortController();
  // Schedule at wall-clock-aligned intervals with advisory lock
  const stop = scheduleAligned(
    "memory-extraction",
    MEMORY_EXTRACTION_INTERVAL_MS,
    async () => {
      await withAdvisoryLock(
        db.$client,
        ADVISORY_LOCK_IDS.memoryExtraction,
        () => processMemoryExtractionBatch(stopping.signal),
        { wait: false },
      );
    },
  );
  return () => {
    stop();
    stopping.abort();
  };
}
