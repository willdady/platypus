import { describe, it, expect } from "vitest";
import type { ConcreteModelId, ReasoningMap } from "@platypus/schemas";
import {
  jobCallSettings,
  jobMaxOutputTokens,
  resolveReasoning,
} from "./reasoning.ts";
import { makeProviderRow } from "./provider-row.test-fixtures.ts";
import type { ProviderRow } from "./provider-write.ts";

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
    expect(resolveReasoning(map, choice, {})).toBeUndefined();
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
        {},
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
    expect(resolveReasoning(QWEN, {}, {})).toEqual({
      chat_template_kwargs: {
        preserve_thinking: true,
        enable_thinking: true,
        reasoning_effort: "low",
      },
    });
  });

  it("prefers the stored choice over the default", () => {
    expect(
      resolveReasoning(QWEN, { reasoningEffort: "high" }, {})
        ?.chat_template_kwargs,
    ).toMatchObject({ reasoning_effort: "high" });
  });

  it("sends nothing for a control with neither a choice nor a default", () => {
    const { default: _, ...noDefault } = QWEN;
    expect(
      resolveReasoning(noDefault, { reasoningThinking: null }, {}),
    ).toEqual({
      chat_template_kwargs: { preserve_thinking: true },
    });
  });

  it("thinking off drops effort and budget", () => {
    expect(
      resolveReasoning(
        QWEN,
        {
          reasoningThinking: false,
          reasoningEffort: "high",
          thinkingBudget: 512,
        },
        {},
      ),
    ).toEqual({
      chat_template_kwargs: { preserve_thinking: true, enable_thinking: false },
    });
  });

  it("treats a map with no thinking switch as thinking on", () => {
    expect(
      resolveReasoning(
        { effort: { low: { think: "low" } }, budget: { field: "b" } },
        { reasoningThinking: false, reasoningEffort: "low", thinkingBudget: 3 },
        {},
      ),
    ).toEqual({ think: "low", b: 3 });
  });

  it("an undeclared stored step falls back to the default, else nothing", () => {
    expect(
      resolveReasoning(QWEN, { reasoningEffort: "max" }, {})
        ?.chat_template_kwargs,
    ).toMatchObject({ reasoning_effort: "low" });
    expect(
      resolveReasoning(
        { effort: { low: { e: 1 } } },
        { reasoningEffort: "max" },
        {},
      ),
    ).toBeUndefined();
  });

  it("sends a budget only when the map names its field", () => {
    expect(
      resolveReasoning({ always: { a: 1 } }, { thinkingBudget: 100 }, {}),
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

describe("jobCallSettings", () => {
  const qwen = "qwen3" as ConcreteModelId;
  // OpenAI chat mode: the path that honours a Reasoning map (ADR-0040).
  const compat = makeProviderRow({
    name: "local",
    modelIds: [{ id: qwen, passthroughFileTypes: [], reasoning: QWEN }],
  });

  it.each([
    ["no block", null],
    ["a block of nulls", { temperature: null, reasoningThinking: null }],
  ] as const)(
    "sends nothing for %s, not even the map's always and default",
    (_, settings) => {
      expect(jobCallSettings(compat, qwen, settings)).toEqual({});
    },
  );

  it("sends Thinking off as the map's fragment, dropping the default effort", () => {
    expect(jobCallSettings(compat, qwen, { reasoningThinking: false })).toEqual(
      {
        providerOptions: {
          local: {
            chat_template_kwargs: {
              preserve_thinking: true,
              enable_thinking: false,
            },
          },
        },
      },
    );
  });

  it("resolves an Effort step the map lacks to the map's default", () => {
    expect(
      jobCallSettings(compat, qwen, { reasoningEffort: "max" }),
    ).toMatchObject({
      providerOptions: {
        local: { chat_template_kwargs: { reasoning_effort: "low" } },
      },
    });
  });

  it("sends set sampling fields under their SDK names", () => {
    expect(
      jobCallSettings(makeProviderRow(), qwen, { temperature: 0.9, topK: 20 }),
    ).toEqual({ temperature: 0.9, topK: 20 });
  });

  it("sends no fragment for a block of sampling alone, even on a mapped model", () => {
    expect(jobCallSettings(compat, qwen, { temperature: 0.2 })).toEqual({
      temperature: 0.2,
    });
  });

  it("keeps the job's default over a fragment's temperature, and a set value over both", () => {
    const withTemp = makeProviderRow({
      name: "local",
      modelIds: [
        {
          id: qwen,
          passthroughFileTypes: [],
          reasoning: {
            thinking: {
              on: {},
              off: { enable_thinking: false, temperature: 0.7 },
            },
          },
        },
      ],
    });
    const defaults = { temperature: 0.3 };
    expect(
      jobCallSettings(withTemp, qwen, { reasoningThinking: false }, defaults),
    ).toEqual({
      temperature: 0.3,
      providerOptions: { local: { enable_thinking: false } },
    });
    expect(
      jobCallSettings(withTemp, qwen, { temperature: 0.9 }, defaults),
    ).toEqual({ temperature: 0.9 });
    expect(jobCallSettings(withTemp, qwen, null, defaults)).toEqual(defaults);
  });

  describe("a value kept from a model that offered a control this one does not", () => {
    // Always thinks, so no switch; a turn that chooses nothing gets `high`.
    const r1 = "r1-distill" as ConcreteModelId;
    const both = makeProviderRow({
      name: "local",
      modelIds: [
        { id: qwen, passthroughFileTypes: [], reasoning: QWEN },
        {
          id: r1,
          passthroughFileTypes: [],
          reasoning: {
            effort: { low: { effort: "low" }, high: { effort: "high" } },
            default: { effort: "high" },
          },
        },
      ],
    });

    it("sends nothing, not the new map's default effort", () => {
      expect(jobCallSettings(both, r1, { reasoningThinking: false })).toEqual(
        {},
      );
    });

    it("applies again on a model that offers the control", () => {
      expect(
        jobCallSettings(both, qwen, { reasoningThinking: false }),
      ).toHaveProperty("providerOptions");
    });

    it("ignores a Thinking budget on a native Provider, which offers none", () => {
      const anthropic = makeProviderRow({ providerType: "Anthropic" });
      expect(
        jobCallSettings(anthropic, qwen, { thinkingBudget: 2048 }),
      ).toEqual({});
    });
  });

  it("sends a native Provider the SDK reasoning level", () => {
    const anthropic = makeProviderRow({ providerType: "Anthropic" });
    expect(
      jobCallSettings(anthropic, qwen, { reasoningThinking: false }),
    ).toEqual({ reasoning: "none" });
  });
});

describe("jobMaxOutputTokens", () => {
  const qwen = "qwen3" as ConcreteModelId;
  /** The compatible Provider, with an optional ceiling on its Model entry. */
  const compatWith = (
    maxOutputTokens?: number,
    providerType: ProviderRow["providerType"] = "OpenAI",
  ) =>
    makeProviderRow({
      name: "local",
      providerType,
      modelIds: [
        {
          id: qwen,
          passthroughFileTypes: [],
          reasoning: QWEN,
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        },
      ],
    });
  const compat = compatWith();

  it("adds a sent Thinking budget to the cap, so thinking cannot crowd out the answer", () => {
    expect(
      jobMaxOutputTokens(compat, qwen, { thinkingBudget: 4096 }, 2048),
    ).toBe(6144);
  });

  it("holds cap plus budget to a lower declared ceiling", () => {
    expect(
      jobMaxOutputTokens(
        compatWith(4096),
        qwen,
        { thinkingBudget: 4096 },
        2048,
      ),
    ).toBe(4096);
  });

  it("holds the bare cap to a ceiling declared below it, with no budget sent", () => {
    expect(jobMaxOutputTokens(compatWith(4096), qwen, null, 8192)).toBe(4096);
  });

  it("holds the cap to the ceiling on a native Provider, whose budget is never sent", () => {
    expect(
      jobMaxOutputTokens(
        compatWith(4096, "Anthropic"),
        qwen,
        { thinkingBudget: 4096 },
        8192,
      ),
    ).toBe(4096);
  });

  it("sends cap plus budget when the declared ceiling is above it", () => {
    expect(
      jobMaxOutputTokens(
        compatWith(10_000),
        qwen,
        { thinkingBudget: 4096 },
        2048,
      ),
    ).toBe(6144);
  });

  it.each([
    ["no budget", compat, { reasoningThinking: true }],
    [
      "Thinking off",
      compat,
      { thinkingBudget: 4096, reasoningThinking: false },
    ],
    [
      "a native Provider",
      makeProviderRow({ providerType: "Anthropic" }),
      { thinkingBudget: 4096 },
    ],
    [
      "a model without a map",
      makeProviderRow({ name: "local" }),
      { thinkingBudget: 4096 },
    ],
  ] as const)("keeps the cap for %s", (_, provider, settings) => {
    expect(jobMaxOutputTokens(provider, qwen, settings, 2048)).toBe(2048);
  });
});
