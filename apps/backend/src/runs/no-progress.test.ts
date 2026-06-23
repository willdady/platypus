import { describe, it, expect } from "vitest";
import {
  createNoProgressDetector,
  NoProgressError,
  DEFAULT_NO_PROGRESS_THRESHOLD,
} from "./no-progress.ts";

type ToolResult = { name: string; input?: unknown; output?: unknown };

/** Builds a single AI SDK step carrying the given tool results. Only the
 *  fields the detector reads (`toolName`, `input`, `output`) are populated. */
const step = (...results: ToolResult[]) => ({
  toolResults: results.map((r, i) => ({
    type: "tool-result" as const,
    toolCallId: `call-${i}`,
    toolName: r.name,
    input: r.input,
    output: r.output,
  })),
});

const evaluate = (
  detector: ReturnType<typeof createNoProgressDetector>,
  steps: ReturnType<typeof step>[],
) => detector.stopCondition({ steps });

describe("createNoProgressDetector", () => {
  it("aborts when the same call returns the same result K times, even with unrelated calls interleaved", () => {
    const detector = createNoProgressDetector(3);
    const board = { cards: [] };
    // Three identical reads of an unchanged board, interleaved with two
    // distinct writes that must NOT contribute to the read's signature count.
    const steps = [
      step({ name: "getBoardState", input: { boardId: "b1" }, output: board }),
      step({
        name: "addComment",
        input: { cardId: "c1", text: "first" },
        output: { ok: true, id: "k1" },
      }),
      step({ name: "getBoardState", input: { boardId: "b1" }, output: board }),
      step({
        name: "addComment",
        input: { cardId: "c2", text: "second" },
        output: { ok: true, id: "k2" },
      }),
      step({ name: "getBoardState", input: { boardId: "b1" }, output: board }),
    ];

    expect(evaluate(detector, steps)).toBe(true);
    expect(detector.tripped()).toEqual({
      toolName: "getBoardState",
      count: 3,
    });
  });

  it("does not abort before the threshold is reached", () => {
    const detector = createNoProgressDetector(3);
    const board = { cards: [] };
    const twoReads = [
      step({ name: "getBoardState", input: { boardId: "b1" }, output: board }),
      step({
        name: "addComment",
        input: { cardId: "c1", text: "x" },
        output: { ok: true, id: "k1" },
      }),
      step({ name: "getBoardState", input: { boardId: "b1" }, output: board }),
    ];

    expect(evaluate(detector, twoReads)).toBe(false);
    expect(detector.tripped()).toBeNull();
  });

  it("does NOT count a repeated call whose result differs each time (productive read-after-write)", () => {
    const detector = createNoProgressDetector(3);
    // Same tool + same args, but the board changes between reads — legitimate
    // progress that must never trip the detector.
    const steps = [
      step({
        name: "getBoardState",
        input: { boardId: "b1" },
        output: { cards: 0 },
      }),
      step({
        name: "addCard",
        input: { boardId: "b1", title: "a" },
        output: { id: "x1" },
      }),
      step({
        name: "getBoardState",
        input: { boardId: "b1" },
        output: { cards: 1 },
      }),
      step({
        name: "addCard",
        input: { boardId: "b1", title: "b" },
        output: { id: "x2" },
      }),
      step({
        name: "getBoardState",
        input: { boardId: "b1" },
        output: { cards: 2 },
      }),
    ];

    expect(evaluate(detector, steps)).toBe(false);
    expect(detector.tripped()).toBeNull();
  });

  it("treats the result as part of the signature: identical args with one differing read does not reach K", () => {
    const detector = createNoProgressDetector(3);
    const same = { cards: [] };
    const steps = [
      step({ name: "getBoardState", input: { boardId: "b1" }, output: same }),
      step({ name: "getBoardState", input: { boardId: "b1" }, output: same }),
      // Result differs on this one → breaks the run of identical signatures.
      step({
        name: "getBoardState",
        input: { boardId: "b1" },
        output: { cards: ["new"] },
      }),
    ];

    expect(evaluate(detector, steps)).toBe(false);
    expect(detector.tripped()).toBeNull();
  });

  it("normalizes argument key order so equivalent args collide", () => {
    const detector = createNoProgressDetector(2);
    const out = { value: 1 };
    const steps = [
      step({ name: "lookup", input: { a: 1, b: 2 }, output: out }),
      step({ name: "lookup", input: { b: 2, a: 1 }, output: out }),
    ];

    expect(evaluate(detector, steps)).toBe(true);
    expect(detector.tripped()?.toolName).toBe("lookup");
  });

  it("does not collide calls to the same tool with different arguments", () => {
    const detector = createNoProgressDetector(2);
    const out = { ok: true };
    const steps = [
      step({ name: "search", input: { q: "alpha" }, output: out }),
      step({ name: "search", input: { q: "beta" }, output: out }),
    ];

    expect(evaluate(detector, steps)).toBe(false);
    expect(detector.tripped()).toBeNull();
  });

  it("honors a custom threshold", () => {
    const detector = createNoProgressDetector(2);
    const board = { cards: [] };
    const steps = [
      step({ name: "getBoardState", input: {}, output: board }),
      step({ name: "getBoardState", input: {}, output: board }),
    ];

    expect(evaluate(detector, steps)).toBe(true);
  });

  it("stays tripped once it has fired", () => {
    const detector = createNoProgressDetector(2);
    const board = { cards: [] };
    const steps = [
      step({ name: "read", input: {}, output: board }),
      step({ name: "read", input: {}, output: board }),
    ];
    expect(evaluate(detector, steps)).toBe(true);
    // A later evaluation with no repeats still reports tripped.
    expect(
      evaluate(detector, [step({ name: "other", output: { a: 1 } })]),
    ).toBe(true);
  });

  it("defaults to a threshold of 3", () => {
    expect(DEFAULT_NO_PROGRESS_THRESHOLD).toBe(3);
    const detector = createNoProgressDetector();
    const board = { cards: [] };
    const twoReads = [
      step({ name: "read", input: {}, output: board }),
      step({ name: "read", input: {}, output: board }),
    ];
    expect(evaluate(detector, twoReads)).toBe(false);
    const threeReads = [
      ...twoReads,
      step({ name: "read", input: {}, output: board }),
    ];
    expect(evaluate(detector, threeReads)).toBe(true);
  });
});

describe("NoProgressError", () => {
  it("is an Error with a machine-parseable, tool-naming message", () => {
    const err = new NoProgressError("getBoardState", 3);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NoProgressError");
    expect(err.reason).toBe("no_progress");
    expect(err.toolName).toBe("getBoardState");
    expect(err.count).toBe(3);
    expect(err.message).toContain("no_progress:");
    expect(err.message).toContain("getBoardState");
    expect(err.message).toContain("3");
  });
});
