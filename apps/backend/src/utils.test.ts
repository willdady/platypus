import { describe, it, expect } from "vitest";
import { dedupeArray } from "./utils";

describe("dedupeArray", () => {
  it("should remove duplicate strings", () => {
    const input = ["a", "b", "a", "c", "b"];
    const result = dedupeArray(input);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("should return empty array for empty input", () => {
    expect(dedupeArray([])).toEqual([]);
  });

  it("should return same array when no duplicates", () => {
    const input = ["a", "b", "c"];
    expect(dedupeArray(input)).toEqual(["a", "b", "c"]);
  });
});
