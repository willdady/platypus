import { describe, it, expect } from "vitest";
import { CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN } from "@platypus/schemas";
import {
  CONTEXT_WINDOW_CUSTOM,
  CONTEXT_WINDOW_PRESETS,
  CONTEXT_WINDOW_UNSET,
  optionForContextWindow,
  parseContextWindowInput,
  contextWindowForOption,
} from "./context-window";

describe("CONTEXT_WINDOW_PRESETS", () => {
  // Decimal, not binary: under-declaring costs a sliver of a window that a
  // vendor hard-fails on when over-declared, so 128k is 128,000 and a genuine
  // 131,072-token model simply forfeits 3k.
  it("reads its sizes as decimal thousands", () => {
    const byLabel = new Map(
      CONTEXT_WINDOW_PRESETS.map((p) => [p.label, p.tokens]),
    );
    expect(byLabel.get("128k")).toBe(128_000);
    expect(byLabel.get("8k")).toBe(8_000);
    expect(byLabel.get("1M")).toBe(1_000_000);
  });

  it("offers only sizes the schema accepts", () => {
    for (const preset of CONTEXT_WINDOW_PRESETS) {
      expect(Number.isInteger(preset.tokens)).toBe(true);
      expect(preset.tokens).toBeGreaterThanOrEqual(CONTEXT_WINDOW_MIN);
      expect(preset.tokens).toBeLessThanOrEqual(CONTEXT_WINDOW_MAX);
    }
  });

  it("lists each size once, ascending", () => {
    const sizes = CONTEXT_WINDOW_PRESETS.map((p) => p.tokens);
    expect(new Set(sizes).size).toBe(sizes.length);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
  });
});

describe("optionForContextWindow", () => {
  it("reads an undeclared window as the unset option", () => {
    expect(optionForContextWindow(undefined)).toBe(CONTEXT_WINDOW_UNSET);
  });

  it("reads a listed size as that size", () => {
    expect(optionForContextWindow(128_000)).toBe("128000");
  });

  // A proxied model whose real capacity is unusual is stored as a plain
  // integer, so the control has to come back showing Custom rather than
  // silently rounding to the nearest option it recognises.
  it("reads any other value as Custom", () => {
    expect(optionForContextWindow(131_072)).toBe(CONTEXT_WINDOW_CUSTOM);
    // Out of bounds still reads as Custom: the row is showing a value the
    // server rejected, and the reader has to see it to fix it.
    expect(optionForContextWindow(128)).toBe(CONTEXT_WINDOW_CUSTOM);
  });
});

describe("contextWindowForOption", () => {
  it("maps a listed size to its integer", () => {
    expect(contextWindowForOption("128000", undefined)).toBe(128_000);
    expect(contextWindowForOption("1000000", 8_000)).toBe(1_000_000);
  });

  it("clears the window when the unset option is chosen", () => {
    expect(
      contextWindowForOption(CONTEXT_WINDOW_UNSET, 128_000),
    ).toBeUndefined();
  });

  // Switching to Custom is the reader opening a text box, not entering a
  // number. Keeping what was there lets them edit 128,000 into 131,072 rather
  // than retype it, and clears nothing they had set.
  it("keeps the current value when switching to Custom", () => {
    expect(contextWindowForOption(CONTEXT_WINDOW_CUSTOM, 128_000)).toBe(
      128_000,
    );
    expect(
      contextWindowForOption(CONTEXT_WINDOW_CUSTOM, undefined),
    ).toBeUndefined();
  });
});

describe("parseContextWindowInput", () => {
  it("reads a typed number", () => {
    expect(parseContextWindowInput("131072")).toBe(131_072);
  });

  it("reads an empty field as no declaration", () => {
    expect(parseContextWindowInput("")).toBeUndefined();
    expect(parseContextWindowInput("   ")).toBeUndefined();
  });

  // Deliberately NOT clamped to the schema's bounds. A `128` typed where
  // 128,000 was meant has to reach the server and be rejected with a message,
  // not be quietly swallowed into "no window declared".
  it("passes a nonsense value through so the schema rejects it", () => {
    expect(parseContextWindowInput("128")).toBe(128);
    expect(parseContextWindowInput("0")).toBe(0);
    expect(parseContextWindowInput("-5")).toBe(-5);
    expect(parseContextWindowInput("1.5")).toBe(1.5);
  });

  it("reads an unparseable field as no declaration", () => {
    expect(parseContextWindowInput("abc")).toBeUndefined();
  });
});
