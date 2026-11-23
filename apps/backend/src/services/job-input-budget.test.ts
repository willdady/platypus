import { describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN, jobInputBudgetChars } from "./job-input-budget.ts";

describe("jobInputBudgetChars", () => {
  it("leaves room for the reply it requests when half the window is too much", () => {
    expect(jobInputBudgetChars(16_000, 8_192)).toBe(7_808 * CHARS_PER_TOKEN);
  });

  it("keeps half the window as the cap on a large window", () => {
    expect(jobInputBudgetChars(200_000, 8_192)).toBe(100_000 * CHARS_PER_TOKEN);
  });

  it("shrinks the budget by a Thinking budget added to the reply", () => {
    const plain = jobInputBudgetChars(16_000, 8_192);
    const thinking = jobInputBudgetChars(16_000, 8_192 + 4_096);

    expect(plain - thinking).toBe(4_096 * CHARS_PER_TOKEN);
  });

  it("returns no budget when the reply fills the window", () => {
    expect(jobInputBudgetChars(8_000, 8_192)).toBe(0);
  });
});
