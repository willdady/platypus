import { describe, it, expect } from "vitest";
import { lineDiff } from "./line-diff";

describe("lineDiff", () => {
  it("marks lines removed, added and kept", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
  });

  it("handles one side empty", () => {
    expect(lineDiff("", "x")).toEqual([
      { kind: "removed", text: "" },
      { kind: "added", text: "x" },
    ]);
    expect(lineDiff("x\ny", "x\ny")).toEqual([
      { kind: "same", text: "x" },
      { kind: "same", text: "y" },
    ]);
  });
});
