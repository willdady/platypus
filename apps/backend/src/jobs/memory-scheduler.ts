import { processMemoryExtractionBatch } from "../services/memory-extraction.ts";
import { logger } from "../logger.ts";
import { db } from "../index.ts";
import { ADVISORY_LOCK_IDS, withAdvisoryLock } from "../db/advisory-lock.ts";
import { scheduleAligned } from "./scheduler.ts";
import { env } from "../env.ts";

export function startMemoryScheduler() {
  const { MEMORY_EXTRACTION_INTERVAL_MS } = env();
  logger.info(
    `Starting memory extraction scheduler (interval: ${MEMORY_EXTRACTION_INTERVAL_MS}ms, wall-clock aligned)`,
  );

  // Schedule at wall-clock-aligned intervals with advisory lock
  scheduleAligned(
    "memory-extraction",
    MEMORY_EXTRACTION_INTERVAL_MS,
    async () => {
      await withAdvisoryLock(
        db.$client,
        ADVISORY_LOCK_IDS.memoryExtraction,
        processMemoryExtractionBatch,
        { wait: false },
      );
    },
  );
}
