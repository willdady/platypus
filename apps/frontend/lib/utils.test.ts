import { describe, it, expect } from "vitest";
import { joinUrl } from "./utils";

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
