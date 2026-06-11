import { describe, it, expect } from "vitest";
import { formatToolDuration, joinUrl, parseValidationErrors } from "./utils";

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

describe("formatToolDuration", () => {
  const start = "2026-05-30T12:00:00.000Z";
  const plus = (ms: number) =>
    new Date(new Date(start).getTime() + ms).toISOString();

  it("returns undefined when a timestamp is missing", () => {
    expect(formatToolDuration(undefined, start)).toBeUndefined();
    expect(formatToolDuration(start, undefined)).toBeUndefined();
  });

  it("returns undefined for invalid or negative durations", () => {
    expect(formatToolDuration("not-a-date", start)).toBeUndefined();
    expect(formatToolDuration(plus(1000), start)).toBeUndefined();
  });

  it("formats sub-second durations in milliseconds", () => {
    expect(formatToolDuration(start, plus(950))).toBe("950ms");
  });

  it("formats sub-minute durations in seconds with one decimal", () => {
    expect(formatToolDuration(start, plus(1200))).toBe("1.2s");
  });

  it("formats durations over a minute as minutes and seconds", () => {
    expect(formatToolDuration(start, plus(63000))).toBe("1m 3s");
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
