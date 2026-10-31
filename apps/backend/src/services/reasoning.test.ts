import { describe, it, expect } from "vitest";
import type { ReasoningMap } from "@platypus/schemas";
import { resolveReasoning } from "./reasoning.ts";

// Qwen-shaped: everything rides in `chat_template_kwargs`, so the deep merge
// across always / thinking / effort is what this map exercises.
const QWEN: ReasoningMap = {
  always: { chat_template_kwargs: { preserve_thinking: true } },
  thinking: {
    on: { chat_template_kwargs: { enable_thinking: true } },
    off: { chat_template_kwargs: { enable_thinking: false } },
  },
  effort: {
    low: { chat_template_kwargs: { reasoning_effort: "low" } },
    high: { chat_template_kwargs: { reasoning_effort: "high" } },
  },
  budget: { field: "thinking_token_budget" },
  default: { thinking: true, effort: "low" },
};

describe("resolveReasoning", () => {
  it.each([
    ["no map", undefined, { reasoningThinking: true, reasoningEffort: "high" }],
    ["an empty map", {}, { reasoningEffort: "high", thinkingBudget: 9 }],
  ] as const)("sends nothing for %s", (_, map, choice) => {
    expect(resolveReasoning(map, choice)).toBeUndefined();
  });

  it("deep-merges always, thinking and effort, then the budget, in that order", () => {
    expect(
      resolveReasoning(
        {
          ...QWEN,
          // a later fragment overrides an earlier one's leaf
          effort: {
            high: {
              chat_template_kwargs: {
                preserve_thinking: false,
                reasoning_effort: "high",
              },
            },
          },
        },
        {
          reasoningThinking: true,
          reasoningEffort: "high",
          thinkingBudget: 512,
        },
      ),
    ).toEqual({
      chat_template_kwargs: {
        preserve_thinking: false,
        enable_thinking: true,
        reasoning_effort: "high",
      },
      thinking_token_budget: 512,
    });
  });

  it("falls back to the map's defaults when nobody chose", () => {
    expect(resolveReasoning(QWEN, {})).toEqual({
      chat_template_kwargs: {
        preserve_thinking: true,
        enable_thinking: true,
        reasoning_effort: "low",
      },
    });
  });

  it("prefers the stored choice over the default", () => {
    expect(
      resolveReasoning(QWEN, { reasoningEffort: "high" })?.chat_template_kwargs,
    ).toMatchObject({ reasoning_effort: "high" });
  });

  it("sends nothing for a control with neither a choice nor a default", () => {
    const { default: _, ...noDefault } = QWEN;
    expect(resolveReasoning(noDefault, { reasoningThinking: null })).toEqual({
      chat_template_kwargs: { preserve_thinking: true },
    });
  });

  it("thinking off drops effort and budget", () => {
    expect(
      resolveReasoning(QWEN, {
        reasoningThinking: false,
        reasoningEffort: "high",
        thinkingBudget: 512,
      }),
    ).toEqual({
      chat_template_kwargs: { preserve_thinking: true, enable_thinking: false },
    });
  });

  it("treats a map with no thinking switch as thinking on", () => {
    expect(
      resolveReasoning(
        { effort: { low: { think: "low" } }, budget: { field: "b" } },
        { reasoningThinking: false, reasoningEffort: "low", thinkingBudget: 3 },
      ),
    ).toEqual({ think: "low", b: 3 });
  });

  it("an undeclared stored step falls back to the default, else nothing", () => {
    expect(
      resolveReasoning(QWEN, { reasoningEffort: "max" })?.chat_template_kwargs,
    ).toMatchObject({ reasoning_effort: "low" });
    expect(
      resolveReasoning(
        { effort: { low: { e: 1 } } },
        { reasoningEffort: "max" },
      ),
    ).toBeUndefined();
  });

  it("sends a budget only when the map names its field", () => {
    expect(
      resolveReasoning({ always: { a: 1 } }, { thinkingBudget: 100 }),
    ).toEqual({ a: 1 });
  });

  describe("sampling keys in a fragment (addendum §1)", () => {
    const map: ReasoningMap = {
      thinking: {
        on: {
          temperature: 0.6,
          top_p: 0.95,
          chat_template_kwargs: { temperature: 1 },
        },
        off: {},
      },
      default: { thinking: true },
    };

    it("the Agent's own value wins over the fragment's", () => {
      expect(resolveReasoning(map, {}, { temperature: 0.2 })).toEqual({
        top_p: 0.95,
        chat_template_kwargs: { temperature: 1 },
      });
    });

    it("the fragment's value fills in what the Agent left blank", () => {
      expect(resolveReasoning(map, {}, {})).toMatchObject({ temperature: 0.6 });
    });

    it("never strips a key nested under chat_template_kwargs", () => {
      expect(
        resolveReasoning(map, {}, { temperature: 0.2, topP: 0.5 }),
      ).toEqual({ chat_template_kwargs: { temperature: 1 } });
    });
  });
});
