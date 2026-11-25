import { describe, it, expect } from "vitest";
import { lineDiff, type DiffLine } from "./line-diff";

function reconstruct(diff: DiffLine[], keep: "same+removed" | "same+added") {
  return diff
    .filter((line) =>
      keep === "same+removed"
        ? line.kind === "same" || line.kind === "removed"
        : line.kind === "same" || line.kind === "added",
    )
    .map((line) => line.text)
    .join("\n");
}

function lcsLength(a: string[], b: string[]): number {
  const table = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table[0][0];
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

  it("diffs 50k lines with a few edits without quadratic blowup", () => {
    const before = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[100] = "changed 100";
    after[25_000] = "changed 25000";
    after.splice(40_000, 2, "inserted a", "inserted b");
    after.splice(10_000, 1);

    const started = performance.now();
    const diff = lineDiff(before.join("\n"), after.join("\n"));
    const elapsed = performance.now() - started;

    expect(reconstruct(diff, "same+removed")).toBe(before.join("\n"));
    expect(reconstruct(diff, "same+added")).toBe(after.join("\n"));
    expect(elapsed).toBeLessThan(2_000);
  });

  it.each([1, 2, 3, 7, 42, 1234])(
    "rebuilds both sides and stays minimal for random inputs (seed %i)",
    (seed) => {
      const random = mulberry32(seed);
      const line = () => `l${Math.floor(random() * 6)}`;
      const side = () =>
        Array.from({ length: Math.floor(random() * 30) }, line);
      const before = side();
      const after = side();

      const diff = lineDiff(before.join("\n"), after.join("\n"));

      expect(reconstruct(diff, "same+removed")).toBe(before.join("\n"));
      expect(reconstruct(diff, "same+added")).toBe(after.join("\n"));
      expect(diff.filter((l) => l.kind === "same")).toHaveLength(
        lcsLength(before, after),
      );
    },
  );
});
