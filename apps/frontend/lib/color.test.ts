// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readableTextColor } from "./color";

describe("readableTextColor", () => {
  it("puts dark text on a light background", () => {
    expect(readableTextColor("#ffffff")).toBe("#0a0a0a");
    expect(readableTextColor("#f59e0b")).toBe("#0a0a0a"); // amber-500
    expect(readableTextColor("#fde047")).toBe("#0a0a0a"); // yellow-300
  });

  it("puts light text on a dark background", () => {
    expect(readableTextColor("#000000")).toBe("#ffffff");
    expect(readableTextColor("#1e3a8a")).toBe("#ffffff"); // blue-900
    expect(readableTextColor("#7c3aed")).toBe("#ffffff"); // violet-600
  });

  it("reads three-digit hex", () => {
    expect(readableTextColor("#fff")).toBe("#0a0a0a");
    expect(readableTextColor("#000")).toBe("#ffffff");
  });

  it("leaves a colour it can't read to the theme", () => {
    expect(readableTextColor("tomato")).toBeUndefined();
    expect(readableTextColor("")).toBeUndefined();
  });
});
