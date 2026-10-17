/**
 * The Trigger form's simple schedule editor maps to and from a five-field cron
 * expression here. A saved expression that fits none of its frequencies
 * parses to `null`, and the form edits it as a raw expression instead.
 */

export type Frequency =
  | "every-5-minutes"
  | "every-10-minutes"
  | "every-15-minutes"
  | "every-30-minutes"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly";

/** A schedule as the simple editor holds it. */
export type SimpleSchedule = {
  frequency: Frequency;
  minute: string;
  hour: string;
  dayOfWeek: string;
  dayOfMonth: string;
};

export function buildCronExpression(
  frequency: Frequency,
  minute: string,
  hour: string,
  dayOfWeek: string,
  dayOfMonth: string,
): string {
  switch (frequency) {
    case "every-5-minutes":
      return "*/5 * * * *";
    case "every-10-minutes":
      return "*/10 * * * *";
    case "every-15-minutes":
      return "*/15 * * * *";
    case "every-30-minutes":
      return "*/30 * * * *";
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${dayOfWeek}`;
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
    default:
      return "0 9 * * *";
  }
}

export function parseCronExpression(expression: string): SimpleSchedule | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (
    minute === "*/5" &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return {
      frequency: "every-5-minutes",
      minute: "0",
      hour: "0",
      dayOfWeek: "0",
      dayOfMonth: "1",
    };
  }

  if (
    minute === "*/10" &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return {
      frequency: "every-10-minutes",
      minute: "0",
      hour: "0",
      dayOfWeek: "0",
      dayOfMonth: "1",
    };
  }

  if (
    minute === "*/15" &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return {
      frequency: "every-15-minutes",
      minute: "0",
      hour: "0",
      dayOfWeek: "0",
      dayOfMonth: "1",
    };
  }

  if (
    minute === "*/30" &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return {
      frequency: "every-30-minutes",
      minute: "0",
      hour: "0",
      dayOfWeek: "0",
      dayOfMonth: "1",
    };
  }

  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    /^\d+$/.test(dayOfMonth) &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return {
      frequency: "monthly",
      minute,
      hour,
      dayOfWeek: "0",
      dayOfMonth,
    };
  }

  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dayOfMonth === "*" &&
    month === "*" &&
    /^\d+$/.test(dayOfWeek)
  ) {
    return {
      frequency: "weekly",
      minute,
      hour,
      dayOfWeek,
      dayOfMonth: "1",
    };
  }

  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return {
      frequency: "daily",
      minute,
      hour,
      dayOfWeek: "0",
      dayOfMonth: "1",
    };
  }

  if (
    /^\d+$/.test(minute) &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return {
      frequency: "hourly",
      minute,
      hour: "0",
      dayOfWeek: "0",
      dayOfMonth: "1",
    };
  }

  return null;
}
