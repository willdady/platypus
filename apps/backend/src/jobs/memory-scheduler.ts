import { processMemoryExtractionBatch } from "../services/memory-extraction.ts";
import { logger } from "../logger.ts";
import { runWithLock, scheduleAligned } from "./scheduler.ts";

const MEMORY_EXTRACTION_INTERVAL_MS = parseInt(
  process.env.MEMORY_EXTRACTION_INTERVAL_MS || "300000", // 5 minutes
);

// Advisory lock ID for memory extraction. Like the scheduler's own, the numeric
// value is load bearing across deploys — never change it.
const MEMORY_EXTRACTION_LOCK_ID = 123456789;

export function startMemoryScheduler() {
  logger.info(
    `Starting memory extraction scheduler (interval: ${MEMORY_EXTRACTION_INTERVAL_MS}ms, wall-clock aligned)`,
  );

  // Schedule at wall-clock-aligned intervals with advisory lock
  scheduleAligned(
    "memory-extraction",
    MEMORY_EXTRACTION_INTERVAL_MS,
    async () => {
      await runWithLock(
        MEMORY_EXTRACTION_LOCK_ID,
        processMemoryExtractionBatch,
      );
    },
  );
}
