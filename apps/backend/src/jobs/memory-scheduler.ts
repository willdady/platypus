import { processMemoryExtractionBatch } from "../services/memory-extraction.ts";
import { logger } from "../logger.ts";
import { db } from "../index.ts";
import { ADVISORY_LOCK_IDS, withAdvisoryLock } from "../db/advisory-lock.ts";
import { scheduleAligned } from "./scheduler.ts";
import { env } from "../env.ts";

/**
 * Starts the memory-extraction worker. Returns a stop handle that clears the
 * tick AND aborts the batch's signal, so a shutdown stops the worker at the
 * next chat boundary instead of running a full batch while the process drains.
 */
export function startMemoryScheduler(): () => void {
  const { MEMORY_EXTRACTION_INTERVAL_MS } = env();
  logger.info(
    `Starting memory extraction scheduler (interval: ${MEMORY_EXTRACTION_INTERVAL_MS}ms, wall-clock aligned)`,
  );

  // The batch is passed the abort signal tied to this worker's stop handle:
  // shutdown is the only thing that aborts it. A batch mid-flight when the
  // handle is called stops before its next Chat; the Chat it is on finishes
  // (aborting mid-write would leave a row in an unrecoverable half-state).
  const stop = new AbortController();

  const stopSchedule = scheduleAligned(
    "memory-extraction",
    MEMORY_EXTRACTION_INTERVAL_MS,
    async () => {
      await withAdvisoryLock(
        db.$client,
        ADVISORY_LOCK_IDS.memoryExtraction,
        () => processMemoryExtractionBatch(stop.signal),
        { wait: false },
      );
    },
  );

  return () => {
    stop.abort();
    stopSchedule();
  };
}
