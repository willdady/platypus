import { describe, it, expect } from "vitest";
import { CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN } from "@platypus/schemas";
import {
  CONTEXT_WINDOW_CUSTOM,
  CONTEXT_WINDOW_PRESETS,
  CONTEXT_WINDOW_UNSET,
  optionForContextWindow,
  parseContextWindowInput,
  contextWindowForOption,
  formatTokens,
} from "./context-window";

describe("CONTEXT_WINDOW_PRESETS", () => {
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

  it("reads any other value as Custom", () => {
    expect(optionForContextWindow(131_072)).toBe(CONTEXT_WINDOW_CUSTOM);
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

describe("formatTokens", () => {
  it("writes a figure under a thousand in full", () => {
    expect(formatTokens(12)).toBe("12");
    expect(formatTokens(260)).toBe("260");
    expect(formatTokens(999)).toBe("999");
  });

  it("abbreviates a thousand and above", () => {
    expect(formatTokens(1_000)).toBe("1K");
    expect(formatTokens(1_100)).toBe("1.1K");
    expect(formatTokens(42_000)).toBe("42K");
    expect(formatTokens(128_000)).toBe("128K");
  });

  it("abbreviates a million and above", () => {
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(2_000_000)).toBe("2M");
    expect(formatTokens(10_000_000)).toBe("10M");
  });

  it("drops a trailing zero rather than showing a false precision", () => {
    expect(formatTokens(1_048_576)).toBe("1M");
    expect(formatTokens(1_100_000)).toBe("1.1M");
    expect(formatTokens(1_050)).toBe("1.1K");
  });

  it("promotes to the next unit when rounding carries", () => {
    expect(formatTokens(999_999)).toBe("1M");
    expect(formatTokens(999_949)).toBe("999.9K");
  });
});
