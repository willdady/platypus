import { describe, it, expect } from "vitest";
import { getCurrentTime, convertTimezone } from "./time.ts";

const ctx = { toolCallId: "test", messages: [] };

describe("getCurrentTime", () => {
  it("returns timezone, timestamp, and formatted fields", async () => {
    const result = await getCurrentTime.execute({}, ctx);
    expect(result).toHaveProperty("timezone");
    expect(result).toHaveProperty("timestamp");
    expect(result).toHaveProperty("formatted");
  });

  it("returns a valid ISO timestamp", async () => {
    const result = await getCurrentTime.execute({}, ctx);
    const date = new Date(result.timestamp);
    expect(isNaN(date.getTime())).toBe(false);
  });
});

describe("convertTimezone", () => {
  it("converts UTC datetime to target timezone", async () => {
    const result = await convertTimezone.execute(
      {
        dateTime: "2025-01-07T14:30:00Z",
        fromTimezone: "UTC",
        toTimezone: "America/New_York",
      },
      ctx,
    );
    expect(result.toTimezone).toBe("America/New_York");
    expect(result.originalDateTime).toBe("2025-01-07T14:30:00Z");
    expect(result.fromTimezone).toBe("UTC");
  });

  it("returns correct ISO format with offset", async () => {
    const result = await convertTimezone.execute(
      {
        dateTime: "2025-01-07T14:30:00Z",
        fromTimezone: "UTC",
        toTimezone: "America/New_York",
      },
      ctx,
    );
    // ISO format with offset: yyyy-MM-dd'T'HH:mm:ssXXX
    expect(result.isoDateTime).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    );
  });

  it("throws for invalid date string", () => {
    expect(() =>
      convertTimezone.execute(
        {
          dateTime: "not-a-date",
          fromTimezone: "UTC",
          toTimezone: "America/New_York",
        },
        ctx,
      ),
    ).toThrow("Invalid date format");
  });
});
