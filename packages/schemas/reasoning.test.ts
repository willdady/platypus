import { describe, it, expect } from "vitest";
import {
  agentCreateSchema,
  agentUpdateSchema,
  chatSubmitSchema,
  modelConfigSchema,
  reasoningMapSchema,
  REASONING_MAP_MAX_BYTES,
} from "./index.ts";

/** The first issue's message, or undefined when the map parsed. */
const errorOf = (map: unknown): string | undefined =>
  reasoningMapSchema.safeParse(map).error?.issues[0]?.message;

// The DeepSeek V4.1 Flash example from #1521's addendum, as the docs carry it.
const DEEPSEEK = {
  thinking: { on: {}, off: { reasoningEffort: "none" } },
  effort: {
    low: { chat_template_kwargs: { reasoning_effort: "low" } },
    high: { chat_template_kwargs: { reasoning_effort: "high" } },
    xhigh: { chat_template_kwargs: { reasoning_effort: "xhigh" } },
    max: { chat_template_kwargs: { reasoning_effort: "max" } },
  },
  budget: { field: "thinking_token_budget" },
  default: { effort: "high" },
};

describe("Reasoning map (#1521)", () => {
  it.each([
    ["an empty map", {}],
    ["the DeepSeek example", DEEPSEEK],
    ["an always-only map", { always: { preserve_thinking: true } }],
    [
      "a thinking default",
      { thinking: { on: {}, off: {} }, default: { thinking: false } },
    ],
  ])("accepts %s", (_, map) => {
    expect(errorOf(map)).toBeUndefined();
  });

  it("rides on a Model entry, and a Model entry without one still parses", () => {
    expect(
      modelConfigSchema.safeParse({ id: "m", reasoning: DEEPSEEK }).success,
    ).toBe(true);
    expect(modelConfigSchema.safeParse({ id: "m" }).success).toBe(true);
  });

  it.each([
    ["always", { always: { messages: [] } }],
    ["thinking.on", { thinking: { on: { stream: false }, off: {} } }],
    ["thinking.off", { thinking: { on: {}, off: { tool_choice: "none" } } }],
    ["effort.high", { effort: { high: { max_tokens: 10 } } }],
  ])("rejects a reserved key in %s, naming it", (where, map) => {
    const message = errorOf(map);
    expect(message).toBeDefined();
    expect(message).toContain(where);
    expect(message).toMatch(/messages|stream|tool_choice|max_tokens/);
  });

  it("does not reserve a key nested below the top level", () => {
    expect(
      errorOf({ always: { chat_template_kwargs: { messages: 1 } } }),
    ).toBeUndefined();
  });

  it("rejects a reserved budget field, naming it", () => {
    expect(errorOf({ budget: { field: "max_completion_tokens" } })).toContain(
      "max_completion_tokens",
    );
  });

  it("rejects an effort step off the scale, naming it", () => {
    expect(errorOf({ effort: { very_high: {} } })).toContain("very_high");
  });

  it("rejects a thinking switch with one side", () => {
    expect(errorOf({ thinking: { on: {} } })).toContain("off");
  });

  it("rejects a default naming an undeclared step, naming it", () => {
    expect(
      errorOf({ effort: { low: {} }, default: { effort: "high" } }),
    ).toContain("high");
  });

  it("rejects a fragment that is not a JSON object", () => {
    expect(errorOf({ always: [1] })).toBeDefined();
  });

  it("rejects a map over the size cap", () => {
    const map = { always: { pad: "x".repeat(REASONING_MAP_MAX_BYTES) } };
    expect(errorOf(map)).toMatch(/16 KB/);
  });
});

describe("Reasoning controls on Agents and Chat turns (#1521)", () => {
  const fields = {
    reasoningThinking: [[true, false], ["yes"]],
    reasoningEffort: [
      ["minimal", "xhigh", "max"],
      ["none", "very_high"],
    ],
    thinkingBudget: [
      [1, 4096],
      [0, -1, 1.5],
    ],
  } as const;

  for (const schema of [agentCreateSchema, agentUpdateSchema]) {
    it.each(Object.entries(fields))(
      "Agent %s validates and clears with null",
      (field, [ok, bad]) => {
        const shape = schema.shape[field as keyof typeof fields];
        for (const v of ok) expect(shape.safeParse(v).success).toBe(true);
        for (const v of bad)
          expect(shape.safeParse(v).success, `${v}`).toBe(false);
        expect(shape.safeParse(null).success).toBe(true);
      },
    );
  }

  it("a Chat turn carries the three fields", () => {
    const parsed = chatSubmitSchema.parse({
      id: "c1",
      workspaceId: "w1",
      providerId: "p1",
      modelId: "m1",
      trigger: "regenerate-message",
      messageId: "m1",
      reasoningThinking: true,
      reasoningEffort: "high",
      thinkingBudget: 2048,
    });
    expect(parsed).toMatchObject({
      reasoningThinking: true,
      reasoningEffort: "high",
      thinkingBudget: 2048,
    });
  });
});
