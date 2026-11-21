import { describe, it, expect, vi } from "vitest";
import { logger } from "../logger.ts";
import { sliceWhole, storable } from "./storable.ts";

describe("storable", () => {
  it("removes NUL from nested strings and object keys", () => {
    expect(
      storable({ "a\u0000b": [{ text: "x\u0000y\u0000" }, "\u0000"] }),
    ).toEqual({ ab: [{ text: "xy" }, ""] });
  });

  it("replaces lone high and low surrogates with U+FFFD", () => {
    expect(storable(["a\uD800", "\uDC00b", "\uDC00\uD800"])).toEqual([
      "a�",
      "�b",
      "��",
    ]);
  });

  it("keeps surrogate pairs, other control characters and escaped-looking text", () => {
    const kept = "😀 \u0001\u001f\u007f￾￿ \\u0000";
    expect(storable({ kept })).toEqual({ kept });
  });

  it("warns for each string it changes, and for no other", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    storable({ kept: "fine", cut: "a\u0000" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual({ length: 2, storedLength: 1 });
    warn.mockRestore();
  });

  it("stores a value with toJSON as JSON.stringify would", () => {
    const at = new Date("2026-11-21T00:00:00.000Z");
    expect(storable({ at })).toEqual({ at: "2026-11-21T00:00:00.000Z" });
  });

  it("leaves non-string values unchanged", () => {
    const value = { n: 1, b: true, z: null, list: [0, false] };
    expect(storable(value)).toEqual({
      n: 1,
      b: true,
      z: null,
      list: [0, false],
    });
  });
});

describe("sliceWhole", () => {
  it("cuts before a surrogate pair the end would split", () => {
    expect(sliceWhole("ab😀", 3)).toBe("ab");
  });

  it("cuts at the end when it falls between characters", () => {
    expect(sliceWhole("ab😀c", 4)).toBe("ab😀");
    expect(sliceWhole("abc", 2)).toBe("ab");
  });
});
