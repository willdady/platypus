import { describe, it, expect } from "vitest";
import { deepEqual } from "./deep-equal";

describe("deepEqual", () => {
  it("compares structurally, ignoring key order", () => {
    expect(
      deepEqual({ a: 1, b: [1, { c: "x" }] }, { b: [1, { c: "x" }], a: 1 }),
    ).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(deepEqual({ a: undefined }, {})).toBe(false);
    expect(deepEqual([], {})).toBe(false);
  });
});
