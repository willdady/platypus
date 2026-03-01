import { describe, it, expect } from "vitest";
import { describeSchedule } from "./cron-utils";

describe("describeSchedule", () => {
  it('should return "Every minute" for * * * * *', () => {
    expect(describeSchedule("* * * * *", "UTC")).toBe("Every minute");
  });

  it('should return "Every 5 minutes" for */5 * * * *', () => {
    expect(describeSchedule("*/5 * * * *", "UTC")).toBe("Every 5 minutes");
  });

  it('should return "Every 15 minutes" for */15 * * * *', () => {
    expect(describeSchedule("*/15 * * * *", "UTC")).toBe("Every 15 minutes");
  });

  it("should describe hourly pattern", () => {
    expect(describeSchedule("30 * * * *", "UTC")).toBe(
      "Every hour at minute 30",
    );
  });

  it("should describe daily pattern with timezone", () => {
    expect(describeSchedule("0 9 * * *", "America/New_York")).toBe(
      "Daily at 09:00 America/New_York",
    );
  });

  it("should describe weekly pattern", () => {
    expect(describeSchedule("0 9 * * 1", "UTC")).toBe(
      "Weekly on Monday at 09:00 UTC",
    );
  });

  it("should describe monthly pattern", () => {
    expect(describeSchedule("0 9 15 * *", "UTC")).toBe(
      "Monthly on day 15 at 09:00 UTC",
    );
  });

  it("should return raw expression for unrecognized patterns", () => {
    // month=6 is not *, so it doesn't match monthly either
    expect(describeSchedule("0 9 1 6 *", "UTC")).toBe("0 9 1 6 *");
  });

  it("should return expression for non-5-part cron", () => {
    expect(describeSchedule("0 9 * *", "UTC")).toBe("0 9 * *");
  });

  it("should return raw expression for invalid cron", () => {
    expect(describeSchedule("invalid", "UTC")).toBe("invalid");
  });
});
