import { afterEach, describe, it, expect, vi } from "vitest";
import { getCurrentTime, convertTimezone } from "./time.ts";
import { callTool } from "../test-utils.ts";

describe("getCurrentTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the current instant in the configured timezone", async () => {
    vi.useFakeTimers({ now: new Date("2025-01-07T14:30:00Z") });

    const result = await callTool(getCurrentTime, {});

    expect(result).toMatchObject({
      timezone: process.env.TIMEZONE || "UTC",
      timestamp: "2025-01-07T14:30:00.000Z",
    });
    expect(result.formatted).toContain("Tuesday, January 7, 2025");
  });
});

describe("convertTimezone", () => {
  it.each([
    // U+2212 minus from ICU normalised to ASCII.
    ["America/New_York", "2025-01-07T09:30:00-05:00"],
    ["Asia/Kolkata", "2025-01-07T20:00:00+05:30"],
  ])("converts to %s as ISO with an explicit offset", async (tz, iso) => {
    expect(
      await callTool(convertTimezone, {
        dateTime: "2025-01-07T14:30:00Z",
        fromTimezone: "UTC",
        toTimezone: tz,
      }),
    ).toEqual({
      originalDateTime: "2025-01-07T14:30:00Z",
      fromTimezone: "UTC",
      toTimezone: tz,
      isoDateTime: iso,
    });
  });

  it("throws for invalid date string", async () => {
    await expect(
      callTool(convertTimezone, {
        dateTime: "not-a-date",
        fromTimezone: "UTC",
        toTimezone: "America/New_York",
      }),
    ).rejects.toThrow("Invalid date format");
  });
});
