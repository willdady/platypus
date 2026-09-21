import { describe, it, expect } from "vitest";
import { formatDate, formatDateTime, formatDateAtTime } from "./format-date";

// These render in the viewer's locale, so the assertions pin the shape of each
// formatter rather than one locale's spelling of it.
describe("format-date", () => {
  // Built from local parts so the expected day holds in any time zone.
  const value = new Date(2026, 8, 21, 14, 5);

  it("renders a day without a time", () => {
    const rendered = formatDate(value);

    expect(rendered).toContain("21");
    expect(rendered).toContain("2026");
    expect(rendered).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("renders a day and a time", () => {
    const rendered = formatDateTime(value);

    expect(rendered).toContain("2026");
    expect(rendered).toMatch(/\d{1,2}:05/);
  });

  it("reads a day and a time as a sentence", () => {
    const rendered = formatDateAtTime(value);

    expect(rendered.startsWith(`${formatDate(value)} at `)).toBe(true);
    expect(rendered).toMatch(/\d{1,2}:05/);
  });

  it("accepts a string and a timestamp as well as a Date", () => {
    expect(formatDate(value.toISOString())).toBe(formatDate(value));
    expect(formatDate(value.getTime())).toBe(formatDate(value));
  });
});
