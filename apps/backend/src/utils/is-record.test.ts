import { describe, expect, it } from "vitest";
import { isRecord } from "./is-record.ts";

describe("isRecord", () => {
  it("accepts an object", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it.each([null, undefined, [], [1], "text", 0, true])(
    "refuses %j",
    (value) => {
      expect(isRecord(value)).toBe(false);
    },
  );
});
