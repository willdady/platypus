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

    expect(formatRelativeTime("2026-01-01T09:00:00Z")).toBe(
      "about 3 hours ago",
    );
  });
});
