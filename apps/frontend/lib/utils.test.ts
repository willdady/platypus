import { describe, it, expect } from "vitest";
import { formatDurationMs, joinUrl, parseValidationErrors } from "./utils";

describe("joinUrl", () => {
  it("should join base URL and path", () => {
    expect(joinUrl("http://localhost:4000", "/api/test")).toBe(
      "http://localhost:4000/api/test",
    );
  });

  it("should handle base URL with trailing slash", () => {
    expect(joinUrl("http://localhost:4000/", "/api/test")).toBe(
      "http://localhost:4000/api/test",
    );
  });

  it("should handle path without leading slash", () => {
    expect(joinUrl("http://localhost:4000", "api/test")).toBe(
      "http://localhost:4000/api/test",
    );
  });

  it("should return path when base is empty", () => {
    expect(joinUrl("", "/api/test")).toBe("/api/test");
  });
});

describe("formatDurationMs", () => {
  it("returns undefined for invalid or negative durations", () => {
    expect(formatDurationMs(NaN)).toBeUndefined();
    expect(formatDurationMs(-1)).toBeUndefined();
  });

  it("formats sub-second durations in milliseconds", () => {
    expect(formatDurationMs(950)).toBe("950ms");
  });

  it("formats sub-minute durations in seconds with one decimal", () => {
    expect(formatDurationMs(1200)).toBe("1.2s");
  });

  it("formats durations over a minute as minutes and seconds", () => {
    expect(formatDurationMs(63000)).toBe("1m 3s");
  });

  it("carries at rounding boundaries instead of rendering 60s (m10)", () => {
    // 59.96s must not render "60.0s" — it rounds up to the next minute.
    expect(formatDurationMs(59960)).toBe("1m 0s");
    // 119.6s must not render "1m 60s".
    expect(formatDurationMs(119600)).toBe("2m 0s");
    // A value safely under the boundary still shows seconds with one decimal.
    expect(formatDurationMs(59900)).toBe("59.9s");
  });
});

describe("parseValidationErrors", () => {
  it("should parse validation errors correctly", () => {
    const errorData = {
      error: [
        { path: ["name"], message: "Name is required" },
        { path: ["email"], message: "Invalid email" },
      ],
    };
    const result = parseValidationErrors(errorData);
    expect(result).toEqual({
      name: "Name is required",
      email: "Invalid email",
    });
  });

  it("should return empty object for invalid input", () => {
    expect(parseValidationErrors(null)).toEqual({});
    expect(parseValidationErrors({})).toEqual({});
    expect(parseValidationErrors({ error: "string" })).toEqual({});
  });
});
