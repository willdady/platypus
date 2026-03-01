import { describe, it, expect } from "vitest";
import { validateCronExpression } from "./cron.ts";

describe("validateCronExpression", () => {
  it("should return a Date for a valid cron expression", () => {
    const result = validateCronExpression("0 9 * * *", "UTC");
    expect(result).toBeInstanceOf(Date);
  });

  it("should return a Date for every-minute expression", () => {
    const result = validateCronExpression("* * * * *", "UTC");
    expect(result).toBeInstanceOf(Date);
  });

  it("should return a Date with a valid timezone", () => {
    const result = validateCronExpression("0 9 * * *", "America/New_York");
    expect(result).toBeInstanceOf(Date);
  });

  it("should return null for an invalid cron expression", () => {
    const result = validateCronExpression("invalid", "UTC");
    expect(result).toBeNull();
  });

  it("should return null for an invalid timezone", () => {
    const result = validateCronExpression("0 9 * * *", "Invalid/Timezone");
    expect(result).toBeNull();
  });

  it("should return null for an empty expression", () => {
    const result = validateCronExpression("", "UTC");
    expect(result).toBeNull();
  });

  it("should handle step expressions", () => {
    const result = validateCronExpression("*/5 * * * *", "UTC");
    expect(result).toBeInstanceOf(Date);
  });

  it("should handle weekly expressions", () => {
    const result = validateCronExpression("0 9 * * 1", "Europe/London");
    expect(result).toBeInstanceOf(Date);
  });
});
