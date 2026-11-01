import { Cron } from "croner";
import type { CronTriggerConfig } from "@platypus/schemas";

/**
 * Validates a cron expression with the given timezone and returns the next run date.
 * Returns null if the expression or timezone is invalid.
 */
export const validateCronExpression = (
  cronExpression: string,
  timezone: string,
): Date | null => {
  try {
    const cron = new Cron(cronExpression, { timezone });
    return cron.nextRun();
  } catch {
    return null;
  }
};

/**
 * The next `nextRunAt` a cron config names, from now — or `null` when the
 * expression or timezone cannot be parsed. The one statement of the schedule
 * rule: the write model, its post-run bookkeeping and the v4 one-off that
 * repairs stranded schedules all call it.
 */
export const nextCronRunAt = (config: CronTriggerConfig): Date | null =>
  validateCronExpression(config.cronExpression, config.timezone);
