import { processMemoryExtractionBatch } from "../services/memory-extraction.ts";
import { logger } from "../logger.ts";
import { ADVISORY_LOCK_IDS } from "../db/advisory-lock.ts";
import { runWithLock, scheduleAligned } from "./scheduler.ts";

const MEMORY_EXTRACTION_INTERVAL_MS = parseInt(
  process.env.MEMORY_EXTRACTION_INTERVAL_MS || "300000", // 5 minutes
);

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
        ADVISORY_LOCK_IDS.memoryExtraction,
        processMemoryExtractionBatch,
      );
    },
  );
}
