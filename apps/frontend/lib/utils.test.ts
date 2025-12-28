import { describe, it, expect } from "vitest";
import { joinUrl, parseValidationErrors } from "./utils";

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
