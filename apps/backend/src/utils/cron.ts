import { Cron } from "croner";

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
