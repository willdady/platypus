import { describe, it, expect, vi, afterEach } from "vitest";
import type { ModelMessage } from "ai";
import {
  BEDROCK_CACHE_POINT,
  buildModelInvocation,
  REQUEST_LEVEL_CACHE_DIRECTIVE,
  type RunPlan,
} from "./run-plan.ts";
import {
  CLEARED_TOOL_INPUT_MARKER,
  CLEARED_TOOL_RESULT_MARKER,
} from "@platypus/schemas";
import { ANSWER_STEP_INSTRUCTION } from "./answer-step.ts";
import { logger } from "../logger.ts";
import { createOverflowRecovery } from "./context-overflow-recovery.ts";

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
        // Any payload works now that the boundary is a count: the batch does
        // not depend on bytes freed.
        output: {
          type: "text" as const,
          value: `content ${i} ${"x".repeat(5_000)}`,
        },
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
          input: {
            path: `f${i}`,
            content: `body ${i} ${"x".repeat(1_400)}`,
            mode: "create",
          },
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
  buildModelInvocation(plan, {
    abortSignal: new AbortController().signal,
    overflowRecovery: createOverflowRecovery(),
  });

/** The `prepareStep` override, as the SDK calls it. */
type PrepareStep = (opts: {
  steps: Array<{ usage?: { inputTokens?: number } }>;
  stepNumber: number;
  messages: ModelMessage[];
}) => Promise<{ messages?: ModelMessage[] }>;

const prepareStepOf = (plan: RunPlan): PrepareStep =>
  invoke(plan).prepareStep as unknown as PrepareStep;

describe("buildModelInvocation prepareStep", () => {
  it("returns a messages override with the cache point on the final message even when nothing is cleared", async () => {
    const prepareStep = prepareStepOf(planOf({ contextWindow: 100 }));
    const messages = toolResultMessages(10);
    const result = await prepareStep({ steps: [], stepNumber: 0, messages });
    const last = result.messages!.at(-1);
    expect(last?.providerOptions).toEqual(BEDROCK_CACHE_POINT);
  });

  // `initialOccupancy` already past threshold clears on the very first call.
  it("carries both Tool-result clearing and the cache point in the same pass", async () => {
    const prepareStep = prepareStepOf(
      planOf({ contextWindow: 100, initialOccupancy: 90 }),
    );
    const messages = toolResultMessages(10);
    const result = await prepareStep({ steps: [], stepNumber: 0, messages });
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
        stepNumber: 1,
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

  it("keeps clearing below the trigger when a reading on the Active path engaged", async () => {
    // The gate flip-flop: the plan's latest reading is under the trigger, but
    // an earlier reading on the path crossed it. Clearing must stay on rather
    // than re-send every result for this turn.
    const prepareStep = prepareStepOf(
      planOf({
        contextWindow: 100,
        initialOccupancy: 60,
        priorOccupancyReadings: [
          { inputTokens: 90, outputTokens: 0 },
          { inputTokens: 60, outputTokens: 0 },
        ],
      }),
    );
    const result = await prepareStep({
      steps: [],
      stepNumber: 0,
      messages: toolResultMessages(10),
    });
    const firstOutput = (
      result.messages![0] as {
        content: Array<{ output: { value: string } }>;
      }
    ).content[0].output;
    expect(firstOutput.value).toBe(CLEARED_TOOL_RESULT_MARKER);
  });

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
        stepNumber: 0,
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
    await prepareStep({ steps: [], stepNumber: 0, messages });
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
    const result = await prepareStep({ steps: [], stepNumber: 0, messages });
    expect(result.messages!.at(-1)?.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled" } },
      ...BEDROCK_CACHE_POINT,
    });
  });

  it("still lands the cache point when the Context window is undeclared (nothing cleared)", async () => {
    const prepareStep = prepareStepOf(planOf({ initialOccupancy: 1_000_000 }));
    const messages = toolResultMessages(10);
    const result = await prepareStep({ steps: [], stepNumber: 0, messages });
    const last = result.messages!.at(-1);
    expect(last?.providerOptions).toEqual(BEDROCK_CACHE_POINT);
  });
});

/**
 * The Step ceiling's answer step (issue #1730), wired once here so every Drive
 * inherits it: the last permitted step is told to answer rather than having its
 * tools taken away.
 */
describe("buildModelInvocation final-step instruction", () => {
  const isInstruction = (message: ModelMessage | undefined): boolean =>
    message?.role === "user" && message.content === ANSWER_STEP_INSTRUCTION;

  it("appends the instruction on the last allowed step and no earlier step", async () => {
    const prepareStep = prepareStepOf(planOf({ maxSteps: 3 }));
    const messages: ModelMessage[] = [{ role: "user", content: "hi" }];

    for (const stepNumber of [0, 1]) {
      const out = await prepareStep({ steps: [], stepNumber, messages });
      expect(out.messages?.some(isInstruction)).toBe(false);
    }

    const last = await prepareStep({ steps: [], stepNumber: 2, messages });
    expect(isInstruction(last.messages?.at(-1))).toBe(true);
  });

  it("puts the instruction on the only step when the ceiling is one", async () => {
    const prepareStep = prepareStepOf(planOf({ maxSteps: 1 }));
    const out = await prepareStep({
      steps: [],
      stepNumber: 0,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(isInstruction(out.messages?.at(-1))).toBe(true);
  });

  // The instruction rides the same pass as clearing and the cache point, and
  // the point has to end up after it: Bedrock's trailing point names the last
  // message of the request, which is now the instruction.
  it("lands the Bedrock cache point on the instruction itself", async () => {
    const prepareStep = prepareStepOf(planOf({ maxSteps: 1 }));
    const out = await prepareStep({
      steps: [],
      stepNumber: 0,
      messages: toolResultMessages(3),
    });

    const last = out.messages!.at(-1);
    expect(isInstruction(last)).toBe(true);
    expect(last?.providerOptions).toEqual(BEDROCK_CACHE_POINT);
  });

  // The point moves rather than accumulates: a conversation carrying one from
  // an earlier step must end with exactly one point, on the instruction. A
  // leftover mid-conversation point counts against Converse's checkpoint cap.
  it("strips an earlier cache point so only the instruction carries one", async () => {
    const cachePointOf = (message: ModelMessage | undefined) => {
      const bedrock = (
        message?.providerOptions as
          { amazonBedrock?: { cachePoint?: { type: string } } } | undefined
      )?.amazonBedrock;
      return bedrock?.cachePoint;
    };
    const prepareStep = prepareStepOf(planOf({ maxSteps: 1 }));
    const messages = toolResultMessages(4).map((message, index) =>
      index === 1
        ? { ...message, providerOptions: BEDROCK_CACHE_POINT }
        : message,
    );

    const out = await prepareStep({ steps: [], stepNumber: 0, messages });
    const carrying = out.messages!.filter(
      (message) => cachePointOf(message) !== undefined,
    );

    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toBe(out.messages!.at(-1));
    expect(cachePointOf(carrying[0])).toEqual(
      BEDROCK_CACHE_POINT.amazonBedrock.cachePoint,
    );
    expect(cachePointOf(out.messages![1])).toBeUndefined();
  });

  // Deliberate: the tool set and tool choice are identical to every earlier
  // step. Removing them would rewrite the cached `tools` prefix (ADR-0020) and
  // on Bedrock drop every tool from a request whose history still holds calls.
  it("changes no tool on the last step, and sends the plan's tools through", async () => {
    const plan = planOf({
      maxSteps: 1,
      tools: { probe: {} as RunPlan["tools"][string] },
    });
    const out = await prepareStepOf(plan)({
      steps: [],
      stepNumber: 0,
      messages: [{ role: "user", content: "hi" }],
    });

    // The override carries a conversation and nothing else, so there is no
    // `activeTools`/`toolChoice` for the SDK to apply to this step.
    expect(Object.keys(out)).toEqual(["messages"]);
    expect(Object.keys(invoke(plan).tools)).toEqual(["probe"]);
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
        stepNumber: 1,
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
      stepNumber: 1,
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
      stepNumber: 1,
      messages: [{ role: "user", content: "hi" }, ...fsWriteMessages(8)],
    });
    expect(evidenceLines(spy)).toEqual([]);
    expect(JSON.stringify(result.messages)).toContain(
      CLEARED_TOOL_INPUT_MARKER,
    );
  });
});
