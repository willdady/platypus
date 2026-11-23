import { describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN, jobInputBudgetChars } from "./job-input-budget.ts";

/**
 * The budget a job call sizes its input to: at most half the declared window,
 * and never so much that the reply it requests would take the call over it.
 */
describe("jobInputBudgetChars", () => {
  it("leaves room for the reply it requests when half the window is too much", () => {
    // 16,000 - 8,192 = 7,808 tokens, whatever the half share would allow.
    expect(jobInputBudgetChars(16_000, 8_192)).toBe(7_808 * CHARS_PER_TOKEN);
  });

  it("keeps half the window as the cap on a large window", () => {
    // 200,000 - 8,192 = 191,808, so the half share still binds.
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
