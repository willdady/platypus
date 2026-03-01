import { Cron } from "croner";

/**
 * Returns a human-readable description of a cron expression.
 */
export const describeSchedule = (
  cronExpression: string,
  timezone: string,
): string => {
  try {
    const cron = new Cron(cronExpression, { timezone });
    const next = cron.nextRun();
    if (!next) return "Invalid schedule";

    const parts = cronExpression.split(" ");
    if (parts.length !== 5) return cronExpression;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    // Every minute
    if (
      minute === "*" &&
      hour === "*" &&
      dayOfMonth === "*" &&
      month === "*" &&
      dayOfWeek === "*"
    ) {
      return "Every minute";
    }

    // Step expressions: */N * * * *
    const stepMatch = minute.match(/^\*\/(\d+)$/);
    if (
      stepMatch &&
      hour === "*" &&
      dayOfMonth === "*" &&
      month === "*" &&
      dayOfWeek === "*"
    ) {
      return `Every ${stepMatch[1]} minutes`;
    }

    // Hourly
    if (
      hour === "*" &&
      dayOfMonth === "*" &&
      month === "*" &&
      dayOfWeek === "*"
    ) {
      return `Every hour at minute ${minute}`;
    }

    // Daily
    if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      return `Daily at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")} ${timezone}`;
    }

    // Weekly
    if (dayOfMonth === "*" && month === "*") {
      const days = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];
      const dayNum = parseInt(dayOfWeek);
      if (!isNaN(dayNum)) {
        return `Weekly on ${days[dayNum]} at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")} ${timezone}`;
      }
    }

    // Monthly
    if (month === "*" && dayOfWeek === "*") {
      return `Monthly on day ${dayOfMonth} at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")} ${timezone}`;
    }

    return cronExpression;
  } catch {
    return cronExpression;
  }
};
