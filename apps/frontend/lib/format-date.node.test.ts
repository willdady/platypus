import { describe, it, expect } from "vitest";
import { formatDate, formatDateTime } from "./format-date";

describe("format-date", () => {
  const locale = "en-US";
  // why: built from local parts, so the expected day holds in any time zone
  const value = new Date(2026, 8, 21, 14, 5);

  it("renders a day without a time", () => {
    expect(formatDate(value, locale)).toBe("Sep 21, 2026");
  });

  it("renders a day and a time", () => {
    expect(formatDateTime(value, locale)).toBe("Sep 21, 2026, 2:05 PM");
  });

  it("accepts a string and a timestamp as well as a Date", () => {
    expect(formatDate(value.toISOString(), locale)).toBe(
      formatDate(value, locale),
    );
    expect(formatDate(value.getTime(), locale)).toBe(formatDate(value, locale));
  });
});
