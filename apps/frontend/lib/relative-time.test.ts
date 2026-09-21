import { describe, it, expect, afterEach, vi } from "vitest";
import { formatRelativeTime } from "./relative-time";

describe("formatRelativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a suffixed, human-readable distance from now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));

    expect(formatRelativeTime(new Date("2026-01-01T11:55:00Z"))).toBe(
      "5 minutes ago",
    );
  });

  it("accepts a date string as well as a Date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));

    expect(formatRelativeTime("2026-01-01T09:00:00Z")).toBe("3 hours ago");
  });

  it("picks the largest unit that fits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));

    expect(formatRelativeTime("2025-12-29T12:00:00Z")).toBe("3 days ago");
    expect(formatRelativeTime("2025-10-01T12:00:00Z")).toBe("3 months ago");
    expect(formatRelativeTime("2023-01-01T12:00:00Z")).toBe("3 years ago");
  });

  it("reads the present as 'now' rather than a zero count", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));

    expect(formatRelativeTime("2026-01-01T12:00:00Z")).toBe("now");
  });

  it("renders a future timestamp without a suffix", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));

    expect(formatRelativeTime("2026-01-01T14:00:00Z")).toBe("in 2 hours");
  });
});
