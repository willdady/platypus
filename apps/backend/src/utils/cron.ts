import { Cron } from "croner";
import type { CronTriggerConfig } from "@platypus/schemas";

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

export const nextCronRunAt = (config: CronTriggerConfig): Date | null =>
  validateCronExpression(config.cronExpression, config.timezone);
