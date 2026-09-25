import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { validateCronExpression } from "./cron.ts";

describe("validateCronExpression", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A Monday, in winter: New York is UTC−5 and London is UTC+0.
    vi.setSystemTime(new Date("2026-01-05T08:30:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["daily", "0 9 * * *", "UTC", "2026-01-05T09:00:00.000Z"],
    ["every-minute", "* * * * *", "UTC", "2026-01-05T08:31:00.000Z"],
    ["step", "*/5 * * * *", "UTC", "2026-01-05T08:35:00.000Z"],
    ["weekly", "0 9 * * 1", "Europe/London", "2026-01-05T09:00:00.000Z"],
    [
      "daily in a zone",
      "0 9 * * *",
      "America/New_York",
      "2026-01-05T14:00:00.000Z",
    ],
  ])(
    "returns the next run for a %s expression, in its timezone",
    (_label, expression, timezone, expected) => {
      expect(validateCronExpression(expression, timezone)?.toISOString()).toBe(
        expected,
      );
    },
  );

  it.each([
    ["an invalid expression", "invalid", "UTC"],
    ["an empty expression", "", "UTC"],
    ["an invalid timezone", "0 9 * * *", "Invalid/Timezone"],
  ])("returns null for %s", (_label, expression, timezone) => {
    expect(validateCronExpression(expression, timezone)).toBeNull();
  });
});
