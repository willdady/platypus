import { afterEach, describe, it, expect, vi } from "vitest";
import { createGetCurrentTime, convertTimezone } from "./time.ts";
import { callTool } from "../test-utils.ts";

describe("getCurrentTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports and formats the current instant in the given timezone", async () => {
    vi.useFakeTimers({ now: new Date("2025-01-07T14:30:00Z") });

    const result = await callTool(
      createGetCurrentTime("Australia/Melbourne"),
      {},
    );

    expect(result).toMatchObject({
      timezone: "Australia/Melbourne",
      timestamp: "2025-01-07T14:30:00.000Z",
    });
    // 01:30 the next day in Melbourne (UTC+11 in January)
    expect(result.formatted).toContain("Wednesday, January 8, 2025");
    expect(result.formatted).toContain("1:30:00 AM");
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

  it.each([
    ["America/New_York", "2025-01-07T19:30:00Z"],
    ["Asia/Tokyo", "2025-01-07T05:30:00Z"],
  ])("reads a zone-less input in fromTimezone %s", async (from, iso) => {
    const result = await callTool(convertTimezone, {
      dateTime: "2025-01-07 14:30",
      fromTimezone: from,
      toTimezone: "Europe/London",
    });
    expect(result.isoDateTime).toBe(iso);
  });

  it("reads a zone-less summer input at fromTimezone's DST offset", async () => {
    const result = await callTool(convertTimezone, {
      dateTime: "2025-07-07T14:30:00",
      fromTimezone: "America/New_York",
      toTimezone: "UTC",
    });
    expect(result.isoDateTime).toBe("2025-07-07T18:30:00Z");
  });

  it("keeps an explicit offset over fromTimezone", async () => {
    const result = await callTool(convertTimezone, {
      dateTime: "2025-01-07T14:30:00+05:00",
      fromTimezone: "Asia/Tokyo",
      toTimezone: "UTC",
    });
    expect(result.isoDateTime).toBe("2025-01-07T09:30:00Z");
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
