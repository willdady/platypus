import { describe, it, expect, vi, afterEach } from "vitest";
import type { ModelMessage } from "ai";
import {
  BEDROCK_CACHE_POINT,
  buildModelInvocation,
  REQUEST_LEVEL_CACHE_DIRECTIVE,
  type RunPlan,
} from "./run-plan.ts";
import { CLEARED_TOOL_RESULT_MARKER } from "./tool-result-clearing.ts";
import { CLEARED_TOOL_INPUT_MARKER } from "./tool-input-clearing.ts";
import { logger } from "../logger.ts";

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

const toolResultMessages = (n: number, toolName = "read_url"): ModelMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: `t${i}`,
        toolName,
        output: { type: "text" as const, value: `content ${i}` },
      },
    ],
  }));

/** `n` successful `fsWrite` calls, each an assistant call and its tool result. */
const fsWriteMessages = (n: number): ModelMessage[] =>
  Array.from({ length: n }, (_, i): ModelMessage[] => [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `w${i}`,
          toolName: "fsWrite",
          input: { path: `f${i}`, content: `body ${i}`, mode: "create" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `w${i}`,
          toolName: "fsWrite",
          output: { type: "json", value: { ok: true } },
        },
      ],
    },
  ]).flat();

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

  // `initialOccupancy` already past threshold clears on the very first call.
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

  it.each([
    [0, 95, true],
    [90, 10, false],
  ])(
    "reads occupancy from the last completed step on later calls, not initialOccupancy (%s → %s clears: %s)",
    async (initialOccupancy, lastStepInput, clears) => {
      const prepareStep = prepareStepOf(
        planOf({ contextWindow: 100, initialOccupancy }),
      );
      const result = await prepareStep({
        steps: [{ usage: { inputTokens: lastStepInput } }],
        messages: toolResultMessages(10),
      });
      const firstOutput = (
        result.messages![0] as {
          content: Array<{ output: { value: string } }>;
        }
      ).content[0].output;
      expect(firstOutput.value === CLEARED_TOOL_RESULT_MARKER).toBe(clears);
    },
  );

  // An MCP tool is clearable only when the turn resolved it read-only
  // (ADR-0021); the plan is how that reaches the clearing pass.
  it.each([
    [new Set(["docs__search"]), true],
    [undefined, false],
  ])(
    "clears an MCP tool's results only when the plan names it read-only (%o)",
    async (readOnlyToolNames, clears) => {
      const prepareStep = prepareStepOf(
        planOf({ contextWindow: 100, initialOccupancy: 90, readOnlyToolNames }),
      );
      const result = await prepareStep({
        steps: [],
        messages: toolResultMessages(10, "docs__search"),
      });
      expect(JSON.stringify(result.messages![0])).toContain(
        clears ? CLEARED_TOOL_RESULT_MARKER : "content 0",
      );
    },
  );

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
        providerOptions: {
          anthropic: { thinking: { type: "enabled" as const } },
        },
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

/**
 * The evidence a later decision on summarising older steps rests on (issue
 * #1717): one structured line whenever a step's reading is at 0.8 of the
 * declared window and Tool-result clearing had nothing left to clear.
 */
describe("buildModelInvocation context-pressure evidence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const evidenceLines = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter(
      ([, message]) =>
        message === "Context near full with nothing left to clear",
    );

  const alreadyCleared = (n: number): ModelMessage[] =>
    toolResultMessages(n).map((message) => ({
      ...message,
      content: (message.content as Array<Record<string, unknown>>).map(
        (part) => ({
          ...part,
          output: { type: "text", value: CLEARED_TOOL_RESULT_MARKER },
        }),
      ),
    })) as ModelMessage[];

  it.each([
    ["no clearable results", [] as ModelMessage[]],
    ["only results already cleared", alreadyCleared(10)],
  ])(
    "logs a step at 0.8 of the window when there is %s",
    async (_, messages) => {
      const spy = vi.spyOn(logger, "info");
      const prepareStep = prepareStepOf(planOf({ contextWindow: 100 }));
      await prepareStep({
        steps: [{ usage: { inputTokens: 85 } }],
        messages: [{ role: "user", content: "hi" }, ...messages],
      });
      expect(evidenceLines(spy)).toEqual([
        [
          expect.objectContaining({ occupancy: 85, contextWindow: 100 }),
          "Context near full with nothing left to clear",
        ],
      ]);
    },
  );

  it.each([
    ["clearing still had results to clear", 85, 100, 10],
    ["the reading is under 0.8 of the window", 79, 100, 0],
    ["no window is declared", 85, undefined, 0],
  ])("logs nothing when %s", async (_, inputTokens, contextWindow, results) => {
    const spy = vi.spyOn(logger, "info");
    const prepareStep = prepareStepOf(planOf({ contextWindow }));
    await prepareStep({
      steps: [{ usage: { inputTokens } }],
      messages: [
        { role: "user", content: "hi" },
        ...toolResultMessages(results),
      ],
    });
    expect(evidenceLines(spy)).toEqual([]);
  });

  // Tool-input clearing (issue #1722) counts as something left to clear.
  it("logs nothing when only write inputs were cleared", async () => {
    const spy = vi.spyOn(logger, "info");
    const prepareStep = prepareStepOf(planOf({ contextWindow: 100 }));
    const result = await prepareStep({
      steps: [{ usage: { inputTokens: 85 } }],
      messages: [{ role: "user", content: "hi" }, ...fsWriteMessages(5)],
    });
    expect(evidenceLines(spy)).toEqual([]);
    expect(JSON.stringify(result.messages)).toContain(
      CLEARED_TOOL_INPUT_MARKER,
    );
  });
});
