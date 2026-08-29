import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  BEDROCK_CACHE_POINT,
  buildModelInvocation,
  REQUEST_LEVEL_CACHE_DIRECTIVE,
  type RunPlan,
} from "./run-plan.ts";
import { CLEARED_TOOL_RESULT_MARKER } from "./tool-result-clearing.ts";

/**
 * `buildModelInvocation` is the one seam every Drive shares (`drive.ts`), so
 * these tests lock the `prepareStep` wiring for Tool-result clearing
 * (ADR-0018 Notes, issue #524) and the trailing Bedrock cache point
 * (ADR-0020 Notes, issue #682) at the level every Drive inherits them from,
 * without a run around it.
 */

const BASE_PLAN: Omit<RunPlan, "model" | "tools" | "maxSteps"> = {};

const planOf = (overrides: Partial<RunPlan> = {}): RunPlan => ({
  model: {} as RunPlan["model"],
  tools: {},
  maxSteps: 5,
  ...BASE_PLAN,
  ...overrides,
});

const toolResultMessages = (n: number): ModelMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: `t${i}`,
        toolName: "read_url",
        output: { type: "text" as const, value: `content ${i}` },
      },
    ],
  }));

const invoke = (plan: RunPlan) =>
  buildModelInvocation(plan, { abortSignal: new AbortController().signal });

/** The `prepareStep` override, as the SDK calls it. */
type PrepareStep = (opts: {
  steps: Array<{ usage?: { inputTokens?: number } }>;
  messages: ModelMessage[];
}) => Promise<{ messages?: ModelMessage[] }>;

const prepareStepOf = (plan: RunPlan): PrepareStep =>
  invoke(plan).prepareStep as unknown as PrepareStep;

describe("buildModelInvocation prepareStep", () => {
  it("returns a messages override with the cache point on the final message even when nothing is cleared", async () => {
    const prepareStep = prepareStepOf(planOf({ contextWindow: 100 }));
    const messages = toolResultMessages(10);
    const result = await prepareStep({ steps: [], messages });
    const last = result.messages!.at(-1);
    expect(last?.providerOptions).toEqual(BEDROCK_CACHE_POINT);
  });

  it("clears stale results on the first call when initialOccupancy is already past threshold", async () => {
    const prepareStep = prepareStepOf(
      planOf({ contextWindow: 100, initialOccupancy: 90 }),
    );
    const messages = toolResultMessages(10);
    const result = await prepareStep({ steps: [], messages });
    expect(result.messages).toBeDefined();
    const firstOutput = (
      result.messages![0] as {
        content: Array<{ output: { value: string } }>;
      }
    ).content[0].output;
    expect(firstOutput.value).toBe(CLEARED_TOOL_RESULT_MARKER);
  });

  it("carries both Tool-result clearing and the cache point in the same pass", async () => {
    const prepareStep = prepareStepOf(
      planOf({ contextWindow: 100, initialOccupancy: 90 }),
    );
    const messages = toolResultMessages(10);
    const result = await prepareStep({ steps: [], messages });
    const firstOutput = (
      result.messages![0] as {
        content: Array<{ output: { value: string } }>;
      }
    ).content[0].output;
    expect(firstOutput.value).toBe(CLEARED_TOOL_RESULT_MARKER);
    const last = result.messages!.at(-1);
    expect(last?.providerOptions).toEqual(BEDROCK_CACHE_POINT);
  });

  it("reads occupancy from the last completed step on later calls, not initialOccupancy", async () => {
    const prepareStep = prepareStepOf(
      planOf({ contextWindow: 100, initialOccupancy: 0 }),
    );
    const messages = toolResultMessages(10);
    const result = await prepareStep({
      steps: [{ usage: { inputTokens: 95 } }],
      messages,
    });
    expect(result.messages).toBeDefined();
  });

  it("does not mutate the messages array or its objects", async () => {
    const prepareStep = prepareStepOf(planOf({}));
    const messages = toolResultMessages(3);
    const snapshot = messages.map((m) => ({ ...m, content: [...m.content] }));
    await prepareStep({ steps: [], messages });
    expect(messages).toEqual(snapshot);
    // Every original message object must be untouched — only the returned
    // array's final entry is a clone carrying the cache point.
    expect(messages.every((m) => m.providerOptions === undefined)).toBe(true);
  });

  it("merges the cache point into, rather than replacing, existing providerOptions", async () => {
    const prepareStep = prepareStepOf(planOf({}));
    const messages = [
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "hi" }],
        providerOptions: { anthropic: { thinking: { type: "enabled" as const } } },
      },
    ];
    const result = await prepareStep({ steps: [], messages });
    expect(result.messages!.at(-1)?.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled" } },
      ...BEDROCK_CACHE_POINT,
    });
  });

  it("still lands the cache point when the Context window is undeclared (nothing cleared)", async () => {
    const prepareStep = prepareStepOf(planOf({ initialOccupancy: 1_000_000 }));
    const messages = toolResultMessages(10);
    const result = await prepareStep({ steps: [], messages });
    const last = result.messages!.at(-1);
    expect(last?.providerOptions).toEqual(BEDROCK_CACHE_POINT);
  });
});

describe("buildModelInvocation request-level cache directive", () => {
  it("sends the Anthropic and OpenRouter ephemeral directives and no Bedrock namespace", () => {
    const invocation = invoke(planOf({}));
    expect(invocation.providerOptions).toEqual(REQUEST_LEVEL_CACHE_DIRECTIVE);
  });
});

describe("buildModelInvocation instructions", () => {
  it("carries the System prompt as a SystemModelMessage with the Bedrock cache point", () => {
    const invocation = invoke(planOf({ system: "You are helpful." }));
    expect(invocation.instructions).toEqual({
      role: "system",
      content: "You are helpful.",
      providerOptions: BEDROCK_CACHE_POINT,
    });
  });

  it("emits no instructions message when the plan has no System prompt", () => {
    const invocation = invoke(planOf({}));
    expect(invocation.instructions).toBeUndefined();
  });
});
