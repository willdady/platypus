import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import {
  simulateReadableStream,
  type Tool,
  type ToolExecutionOptions,
} from "ai";
import { z } from "zod";
import {
  COLLIDING_SUB_AGENT_NAME_REASON,
  createDelegateTool,
  createDelegateTools,
  createSubAgentDelegate,
  type LoadedSubAgentTools,
  SUB_AGENT_STEP_LIMIT_NOTE,
  SUB_AGENT_TRUNCATION_NOTE,
} from "./sub-agent.ts";
import type { SubAgentActivity } from "@platypus/schemas";
import { DELEGATE_TOOL_NAME } from "./turn-tool-names.ts";
import { runRegistry } from "../runs/run-registry.ts";
import { TEST_USAGE_MODEL } from "../runs/run-plan.test-fixtures.ts";
import { orgScope, workspaceScope, type WorkspaceScope } from "../scope.ts";
import { DEFAULT_AGENT_MAX_STEPS } from "@platypus/schemas";

const { streamTextSpy } = vi.hoisted(() => ({ streamTextSpy: vi.fn() }));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    streamText: (options: Parameters<typeof actual.streamText>[0]) => {
      streamTextSpy(options);
      return actual.streamText(options);
    },
  };
});

import { logger } from "../logger.ts";
import {
  registerToolGate,
  type ToolGateRegistration,
} from "../tool-gates/index.ts";

const GATE_SCOPE = {
  orgId: "org-1",
  workspaceId: "ws-1",
  attended: false,
  toolSetIds: new Map<string, string>(),
  readOnlyHints: new Map<string, "read-only" | "writes">(),
};

const USAGE = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};

type StepParts = LanguageModelV3StreamPart[];

const step = (
  parts: StepParts,
  finish: { unified: "stop" | "length" | "tool-calls"; raw?: string } = {
    unified: "stop",
    raw: "stop",
  },
): StepParts => [
  { type: "stream-start", warnings: [] },
  ...parts,
  {
    type: "finish",
    finishReason: { ...finish, raw: finish.raw },
    usage: USAGE,
  },
];

const modelOf = (...steps: StepParts[]) => {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: () => {
      const parts = steps[Math.min(index, steps.length - 1)];
      index += 1;
      return Promise.resolve({
        stream: simulateReadableStream({ chunks: parts }),
      });
    },
  });
};

const text = (id: string, ...deltas: string[]): StepParts => [
  { type: "text-start", id },
  ...deltas.map((delta) => ({ type: "text-delta" as const, id, delta })),
  { type: "text-end", id },
];

const toolCall = (id: string, toolName: string, input: string): StepParts => [
  { type: "tool-input-start", id, toolName },
  { type: "tool-input-end", id },
  { type: "tool-call", toolCallId: id, toolName, input },
];

const parentScope: WorkspaceScope = workspaceScope(
  orgScope({ principal: { kind: "user", userId: "u1", name: "Ada" } }, "org-1"),
  "ws-1",
  true,
);

const toolsOf =
  (tools: Record<string, Tool>) => (): Promise<LoadedSubAgentTools> =>
    Promise.resolve({
      tools,
      readOnlyToolNames: new Set(),
      gateScope: GATE_SCOPE,
    });

const baseOptions = {
  id: "agent-1",
  name: "Research Agent",
  loadTools: toolsOf({}),
};

type LegacyOptions = Partial<{
  id: string;
  name: string;
  description: string;
  instructions: string;
  model: ReturnType<typeof modelOf>;
  loadTools: () => Promise<LoadedSubAgentTools>;
  maxSteps: number;
  securityGuardrails: string | null;
  sampling: Partial<
    Record<
      | "temperature"
      | "topP"
      | "topK"
      | "seed"
      | "presencePenalty"
      | "frequencyPenalty",
      number
    >
  >;
  maxOutputTokens: number;
  parentRun: Parameters<typeof createSubAgentDelegate>[0]["parentRun"];
}>;

const buildOptions = (
  overrides: LegacyOptions = {},
): Parameters<typeof createSubAgentDelegate>[0] => {
  const {
    model = modelOf(step([])),
    maxSteps = DEFAULT_AGENT_MAX_STEPS,
    securityGuardrails = null,
    sampling = {},
    maxOutputTokens,
    ...rest
  } = overrides;
  return {
    ...baseOptions,
    ...rest,
    plan: {
      model,
      usageModel: TEST_USAGE_MODEL,
      maxSteps,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...sampling,
    },
    guardrails: securityGuardrails,
  };
};

const delegateToolFor = (
  options: Parameters<typeof createSubAgentDelegate>[0],
) => createDelegateTool([createSubAgentDelegate(options)]);

const delegate = async (
  options: LegacyOptions = {},
  execOptions: Partial<ToolExecutionOptions<Record<string, unknown>>> = {},
) => {
  const built = buildOptions(options);
  const tool = delegateToolFor(built);
  const gen = tool.execute({ subAgent: built.name, task: "Do something" }, {
    ...execOptions,
  } as ToolExecutionOptions<
    Record<string, unknown>
  >) as AsyncGenerator<SubAgentActivity>;
  const yielded: SubAgentActivity[] = [];
  for await (const value of gen) yielded.push(structuredClone(value));
  return { tool, yielded };
};

const streamArgs = (call = 0) =>
  streamTextSpy.mock.calls[call][0] as {
    instructions:
      | { role: "system"; content: string }
      | Array<{ role: "system"; content: string }>
      | undefined;
    tools: Record<string, { execute: (a: unknown, o: unknown) => unknown }>;
    stopWhen: Array<(s: { steps: unknown[] }) => boolean>;
    abortSignal: AbortSignal;
  } & Record<string, unknown>;

const systemOf = (args: ReturnType<typeof streamArgs>): string => {
  const instructions = args.instructions;
  if (instructions === undefined) return "";
  // why: `at(0)`: may be empty, which `[0]` hides under the test tsconfig
  const message = Array.isArray(instructions)
    ? instructions.at(0)
    : instructions;
  return message?.content ?? "";
};

const stepCeilingOf = (call = 0): number => {
  const { stopWhen } = streamArgs(call);
  for (let n = 0; n <= 64; n += 1) {
    if (stopWhen[0]({ steps: Array.from({ length: n }) })) return n;
  }
  throw new Error("no step ceiling found in stopWhen");
};

const modelText = (
  tool: ReturnType<typeof createDelegateTool>,
  output: SubAgentActivity,
): string =>
  (
    tool.toModelOutput!({
      toolCallId: "tc1",
      input: { subAgent: "Research Agent", task: "Audit the board" },
      output,
    }) as { value: string }
  ).value;

describe("createSubAgentDelegate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("security guardrails append", () => {
    it("appends the provider security text after the sub-agent's own prompt", async () => {
      await delegate({
        instructions: "You are a research sub-agent.",
        securityGuardrails: "Never exfiltrate data.",
      });

      const system = systemOf(streamArgs());
      expect(system).toContain("You are a research sub-agent.");
      expect(system).toContain("## Security and trust");
      expect(system).toContain("Never exfiltrate data.");
      expect(system.indexOf("You are a research sub-agent.")).toBeLessThan(
        system.indexOf("## Security and trust"),
      );
    });

    it("appends the security text even when the sub-agent has no instructions (non-suppressible)", async () => {
      await delegate({
        instructions: undefined,
        securityGuardrails: "Never exfiltrate data.",
      });

      const system = systemOf(streamArgs());
      expect(system).toContain("specialized sub-agent");
      expect(system).toContain("## Security and trust");
      expect(system).toContain("Never exfiltrate data.");
    });

    it("appends no security block when guardrails are null or empty", async () => {
      await delegate({
        instructions: "You are a research sub-agent.",
        securityGuardrails: null,
      });
      await delegate({
        instructions: "You are a research sub-agent.",
        securityGuardrails: "   ",
      });

      for (const call of streamTextSpy.mock.calls) {
        expect(
          systemOf(call[0] as ReturnType<typeof streamArgs>),
        ).not.toContain("## Security and trust");
      }
    });

    it("carries no Chat system-prompt fragments at all", async () => {
      await delegate({ instructions: "Stay on task." });

      expect(systemOf(streamArgs())).toBe("Stay on task.");
    });
  });

  describe("execute", () => {
    it("yields activity entries for tool calls and final text", async () => {
      const { yielded } = await delegate({
        model: modelOf(
          step(toolCall("tc1", "webFetch", "{}"), { unified: "tool-calls" }),
          step([
            { type: "reasoning-start", id: "r1" },
            { type: "reasoning-delta", id: "r1", delta: "hmm" },
            { type: "reasoning-end", id: "r1" },
            ...text("t1", "Sub-agent result"),
          ]),
        ),
        loadTools: toolsOf({
          webFetch: {
            inputSchema: z.object({}),
            execute: () => Promise.resolve("result"),
          },
        }),
      });

      const final = yielded.at(-1)!;
      expect(final.entries).toEqual([
        { type: "tool-call", toolName: "webFetch", status: "completed" },
        { type: "thinking", status: "completed" },
        { type: "generating", status: "completed" },
      ]);
      expect(final.text).toBe("Sub-agent result");

      expect(yielded[0].entries).toEqual([
        { type: "tool-call", toolName: "webFetch", status: "running" },
      ]);
    });

    it("stops a delegate's own tool call when a Tool gate denies it", async () => {
      const seen: unknown[] = [];
      const gate: ToolGateRegistration = {
        id: "no-fetch",
        name: "No fetch",
        timeoutMs: 1_000,
        evaluate: (call) => {
          seen.push(call);
          return { verdict: "deny" };
        },
      };
      registerToolGate(gate);
      const execute = vi.fn(() => Promise.resolve("result"));
      try {
        await delegate({
          model: modelOf(
            step(toolCall("tc1", "webFetch", "{}"), { unified: "tool-calls" }),
            step(text("t1", "Could not fetch.")),
          ),
          loadTools: toolsOf({
            webFetch: { inputSchema: z.object({}), execute },
          }),
        });
      } finally {
        // why: the registry cannot unregister, so silence this gate for later cases
        gate.evaluate = () => ({ verdict: "allow" });
      }

      expect(execute).not.toHaveBeenCalled();
      expect(seen).toEqual([
        expect.objectContaining({ toolName: "webFetch", attended: false }),
      ]);
    });

    it("does not yield again for a delta that changes no activity entry", async () => {
      const { yielded } = await delegate({
        model: modelOf(step(text("t1", "one ", "two ", "three"))),
      });

      expect(yielded).toHaveLength(3);
      expect(yielded.at(-1)!.text).toBe("one two three");
    });

    it("aggregates assistant text across steps, not just the final step's", async () => {
      const { yielded } = await delegate({
        model: modelOf(
          step([...text("t1", "Here are ", "the boards.")], {
            unified: "tool-calls",
          }),
          step([]),
        ),
      });

      expect(yielded.at(-1)!.text).toBe("Here are the boards.");
    });

    it("joins multiple distinct text blocks with blank lines", async () => {
      const { yielded } = await delegate({
        model: modelOf(
          step([...text("t1", "First block."), ...text("t2", "Second block.")]),
        ),
      });

      expect(yielded.at(-1)!.text).toBe("First block.\n\nSecond block.");
    });

    it("falls back to a summary of the final tool result when the sub-agent produced no assistant text", async () => {
      const { yielded } = await delegate({
        model: modelOf(
          step(toolCall("tc1", "listBoards", "{}"), { unified: "tool-calls" }),
          step([]),
        ),
        loadTools: toolsOf({
          listBoards: {
            inputSchema: z.object({}),
            execute: () => Promise.resolve([{ id: "b1", name: "Board One" }]),
          },
        }),
      });

      const final = yielded.at(-1)!;
      expect(final.text).toContain("listBoards");
      expect(final.text).toContain("Board One");
    });

    it("throws when the sub-agent stream reports an error", async () => {
      await expect(
        delegate({
          model: modelOf(
            step([
              ...text("t1", "I'll start by inspecting the agent."),
              {
                type: "error",
                error: new Error(
                  "Model tried to call unavailable tool 'delegateToDashboardAgent'.",
                ),
              },
            ]),
          ),
        }),
      ).rejects.toThrow(
        /Sub-agent "Research Agent" did not complete: Model tried to call unavailable tool/,
      );
    });

    it("includes any partial text in the failure so the work is not lost", async () => {
      await expect(
        delegate({
          model: modelOf(
            step([
              ...text("t1", "Found 3 stale cards."),
              { type: "error", error: new Error("upstream connection reset") },
            ]),
          ),
        }),
      ).rejects.toThrow(
        /Partial output before the failure:\nFound 3 stale cards\./,
      );
    });

    it("records the failure in the activity log before throwing", async () => {
      const yielded: SubAgentActivity[] = [];
      const tool = delegateToolFor(
        buildOptions({
          model: modelOf(step([{ type: "error", error: new Error("boom") }])),
        }),
      );
      const gen = tool.execute(
        { subAgent: "Research Agent", task: "Do something" },
        {} as ToolExecutionOptions<Record<string, unknown>>,
      ) as AsyncGenerator<SubAgentActivity>;

      await expect(
        (async () => {
          for await (const value of gen) yielded.push(structuredClone(value));
        })(),
      ).rejects.toThrow(/boom/);

      expect(yielded.at(-1)?.entries).toContainEqual({
        type: "failed",
        status: "error",
        error: "boom",
      });
    });

    it("marks tool-call entry as error when the sub-agent's tool fails", async () => {
      const { yielded } = await delegate({
        model: modelOf(
          step(toolCall("tc1", "webFetch", "{}"), { unified: "tool-calls" }),
          step([]),
        ),
        loadTools: toolsOf({
          webFetch: {
            inputSchema: z.object({}),
            execute: () => Promise.reject(new Error("Connection refused")),
          },
        }),
      });

      expect(yielded.at(-1)!.entries).toContainEqual({
        type: "tool-call",
        toolName: "webFetch",
        status: "error",
        error: "Connection refused",
      });
    });

    it("logs what the model emitted for a rejected tool call", async () => {
      const raw = '{"url":"https://example.com/a-page","selecto';
      await delegate({
        model: modelOf(
          step(toolCall("tc1", "webFetch", raw), { unified: "tool-calls" }),
          step([]),
        ),
        loadTools: toolsOf({
          webFetch: {
            inputSchema: z.object({ url: z.string() }),
            execute: () => Promise.resolve("ok"),
          },
        }),
      });

      const logged = vi
        .mocked(logger.debug)
        .mock.calls.find((call) => call[1] === "Tool call failed");
      expect(logged?.[0]).toMatchObject({
        subAgentId: "agent-1",
        subAgentName: "Research Agent",
        toolCallId: "tc1",
        toolName: "webFetch",
        inputType: "string",
        inputKind: "unparseable",
        inputLength: raw.length,
        inputPrefix: raw,
      });
    });

    it("says nothing about a sub-agent tool call that succeeded", async () => {
      await delegate({
        model: modelOf(
          step(toolCall("tc1", "webFetch", '{"url":"https://example.com"}'), {
            unified: "tool-calls",
          }),
          step([]),
        ),
        loadTools: toolsOf({
          webFetch: {
            inputSchema: z.object({ url: z.string() }),
            execute: () => Promise.resolve("page text"),
          },
        }),
      });

      expect(
        vi
          .mocked(logger.debug)
          .mock.calls.filter((call) => call[1] === "Tool call failed"),
      ).toHaveLength(0);
    });

    it("accumulates entries across multiple events", async () => {
      const { yielded } = await delegate({
        model: modelOf(
          step(
            [
              ...toolCall("tc1", "search", "{}"),
              ...toolCall("tc2", "fetch", "{}"),
            ],
            { unified: "tool-calls" },
          ),
          step([]),
        ),
        loadTools: toolsOf({
          search: {
            inputSchema: z.object({}),
            execute: () => Promise.resolve("a"),
          },
          fetch: {
            inputSchema: z.object({}),
            execute: () => Promise.resolve("b"),
          },
        }),
      });

      expect(yielded[0].entries).toHaveLength(1);
      expect(yielded[1].entries).toHaveLength(2);
    });
  });

  describe("run lifecycle", () => {
    it("generates with its own abort signal rather than the parent's", async () => {
      const parent = new AbortController();
      await delegate({}, { abortSignal: parent.signal });

      const { abortSignal } = streamArgs();
      expect(abortSignal).toBeInstanceOf(AbortSignal);
      expect(abortSignal).not.toBe(parent.signal);
    });

    it("registers under the bounds the parent run was started with", async () => {
      const register = vi.spyOn(runRegistry, "register");
      await delegate({
        parentRun: {
          runId: "parent-1",
          scope: parentScope,
          timeouts: { perStepTimeoutMs: 600_000, perRunTimeoutMs: 3_600_000 },
          setDelegateUsage: () => undefined,
        },
      });

      expect(register.mock.calls.at(-1)?.[1]).toMatchObject({
        perStepTimeoutMs: 600_000,
        perRunTimeoutMs: 3_600_000,
      });
      register.mockRestore();
    });

    it("drives the delegated run with the no-progress stop condition", async () => {
      await delegate({});

      const { stopWhen } = streamArgs();
      expect(stopWhen).toHaveLength(2);
    });

    it("does not start work for a parent that was already cancelled", async () => {
      const parent = new AbortController();
      parent.abort(new Error("Chat run cancelled"));

      await expect(
        delegate(
          { model: modelOf(step(text("t1", "should never be produced"))) },
          { abortSignal: parent.signal },
        ),
      ).rejects.toThrow(/Stopped before finishing/);
    });

    it("stops the delegated run when the parent run is cancelled", async () => {
      const parent = new AbortController();
      const tool = delegateToolFor(
        buildOptions({ model: modelOf(step(text("t1", "half an answ"))) }),
      );
      const gen = tool.execute(
        { subAgent: "Research Agent", task: "Do something" },
        {
          abortSignal: parent.signal,
        } as ToolExecutionOptions<Record<string, unknown>>,
      ) as AsyncGenerator<SubAgentActivity>;

      await expect(
        (async () => {
          for await (const _ of gen) {
            void _;
            parent.abort(new Error("Chat run cancelled"));
          }
        })(),
      ).rejects.toThrow(/Stopped before finishing/);
    });

    it("records the delegated run's step count and token usage", async () => {
      await delegate({
        model: modelOf(
          step(toolCall("tc1", "noop", "{}"), { unified: "tool-calls" }),
          step(text("t1", "done")),
        ),
        loadTools: toolsOf({
          noop: {
            inputSchema: z.object({}),
            execute: () => Promise.resolve("ok"),
          },
        }),
      });

      const finished = vi
        .mocked(logger.info)
        .mock.calls.find((call) => call[1] === "Sub-agent run finished");
      expect(finished?.[0]).toMatchObject({
        subAgentId: "agent-1",
        status: "succeeded",
        stats: {
          steps: 2,
          inputTokens: 20,
          outputTokens: 8,
          contextOccupancy: 10,
        },
      });
    });
  });

  describe("truncated at the output token limit", () => {
    const truncated = () =>
      modelOf(
        step(text("t1", "The three stale cards are"), {
          unified: "length",
          raw: "max_tokens",
        }),
      );

    it("flags the delegation result as truncated", async () => {
      const { yielded } = await delegate({ model: truncated() });
      const final = yielded.at(-1)!;

      expect(final.truncatedByTokenLimit).toBe(true);
      expect(final.text).toBe("The three stale cards are");
    });

    it("tells the parent model the answer is partial", async () => {
      const { tool, yielded } = await delegate({ model: truncated() });

      const value = modelText(tool, yielded.at(-1)!);
      expect(value).toContain("The three stale cards are");
      expect(value).toContain(SUB_AGENT_TRUNCATION_NOTE);
    });

    it("says only that the answer was cut off when there is no text at all", () => {
      const tool = delegateToolFor(buildOptions());

      expect(
        modelText(tool, {
          entries: [],
          text: "",
          truncatedByTokenLimit: true,
        }),
      ).toBe(SUB_AGENT_TRUNCATION_NOTE);
    });

    it("records the cutoff in the log", async () => {
      await delegate({ model: truncated() });

      const warned = vi
        .mocked(logger.warn)
        .mock.calls.find((call) =>
          String(call[1]).includes(
            "answer truncated at the output token limit",
          ),
        );
      expect(warned?.[0]).toMatchObject({
        subAgentId: "agent-1",
        subAgentName: "Research Agent",
        rawFinishReason: "max_tokens",
      });
    });

    it("leaves a cleanly finished delegation unflagged", async () => {
      const { tool, yielded } = await delegate({
        model: modelOf(step(text("t1", "All done."))),
      });
      const final = yielded.at(-1)!;

      expect(final).not.toHaveProperty("truncatedByTokenLimit");
      expect(modelText(tool, final)).toBe("All done.");
    });

    it("flags a delegation cut off on a step carrying a tool call", async () => {
      const listCards = vi.fn(() => Promise.resolve([{ id: "c1" }]));
      const { yielded } = await delegate({
        model: modelOf(
          step(toolCall("tc1", "listCards", "{}"), {
            unified: "length",
            raw: "max_tokens",
          }),
          step(text("t1", "One card.")),
        ),
        loadTools: toolsOf({
          listCards: { inputSchema: z.object({}), execute: listCards },
        }),
      });

      expect(listCards).not.toHaveBeenCalled();
      expect(yielded.at(-1)!).toHaveProperty("truncatedByTokenLimit", true);
    });

    it("adds no activity entry and no extra yield for the terminal finish", async () => {
      const { yielded } = await delegate({ model: truncated() });

      expect(yielded).toHaveLength(3);
      expect(yielded.at(-1)!.entries).toHaveLength(1);
    });

    it("still throws when the stream also reported a failure", async () => {
      await expect(
        delegate({
          model: modelOf(
            step(
              [
                ...text("t1", "partial"),
                { type: "error", error: new Error("upstream reset") },
              ],
              { unified: "length", raw: "max_tokens" },
            ),
          ),
        }),
      ).rejects.toThrow(/upstream reset/);
    });
  });

  describe("stopped at the step ceiling", () => {
    const haltedAtCeiling = (overrides: LegacyOptions = {}) =>
      delegate({
        maxSteps: 1,
        model: modelOf(
          step(toolCall("tc1", "noop", "{}"), {
            unified: "tool-calls",
            raw: "tool_use",
          }),
          step(text("t1", "the answer that never came")),
        ),
        loadTools: toolsOf({
          noop: {
            inputSchema: z.object({}),
            execute: () => Promise.resolve("ok"),
          },
        }),
        ...overrides,
      });

    it("flags the delegation result", async () => {
      const { yielded } = await haltedAtCeiling();

      expect(yielded.at(-1)!.stoppedAtStepLimit).toBe(true);
    });

    it("tells the parent model the answer is not a finished one", async () => {
      const { tool, yielded } = await haltedAtCeiling();

      const value = modelText(tool, yielded.at(-1)!);
      expect(value).toContain(SUB_AGENT_STEP_LIMIT_NOTE);
      expect(value).not.toContain(SUB_AGENT_TRUNCATION_NOTE);
    });

    it("records the stop in the log", async () => {
      await haltedAtCeiling();

      const warned = vi
        .mocked(logger.warn)
        .mock.calls.find((call) =>
          String(call[1]).includes("stopped at its step ceiling"),
        );
      expect(warned?.[0]).toMatchObject({
        subAgentId: "agent-1",
        subAgentName: "Research Agent",
        rawFinishReason: "tool_use",
      });
    });

    it("leaves a delegation the model finished unflagged", async () => {
      const { tool, yielded } = await delegate({
        model: modelOf(step(text("t1", "All done."))),
      });
      const final = yielded.at(-1)!;

      expect(final).not.toHaveProperty("stoppedAtStepLimit");
      expect(modelText(tool, final)).toBe("All done.");
    });

    it("leaves a delegation whose last allowed step answered unflagged", async () => {
      const { yielded } = await delegate({
        maxSteps: 2,
        model: modelOf(
          step(toolCall("tc1", "noop", "{}"), {
            unified: "tool-calls",
            raw: "tool_use",
          }),
          step(text("t1", "One card.")),
        ),
        loadTools: toolsOf({
          noop: {
            inputSchema: z.object({}),
            execute: () => Promise.resolve("ok"),
          },
        }),
      });

      expect(yielded.at(-1)!).not.toHaveProperty("stoppedAtStepLimit");
      expect(yielded.at(-1)!.text).toBe("One card.");
    });
  });

  describe("sampling parameters", () => {
    it("passes the sub-agent's own sampling parameters to its run", async () => {
      await delegate({ sampling: { temperature: 0.2, topP: 0.9, seed: 42 } });

      expect(streamArgs()).toMatchObject({
        temperature: 0.2,
        topP: 0.9,
        seed: 42,
      });
    });

    it("omits parameters that were never set rather than sending undefined", async () => {
      await delegate({ sampling: { temperature: 0.2 } });

      const settings = streamArgs();
      expect(settings.temperature).toBe(0.2);
      for (const key of [
        "topP",
        "topK",
        "seed",
        "presencePenalty",
        "frequencyPenalty",
      ]) {
        expect(settings).not.toHaveProperty(key);
      }
    });

    it("passes the sub-agent model's output ceiling to its run", async () => {
      await delegate({ maxOutputTokens: 64000 });

      expect(streamArgs()).toMatchObject({ maxOutputTokens: 64000 });
    });

    it("sends no ceiling when the sub-agent's model declares none", async () => {
      await delegate({});

      expect(streamArgs()).not.toHaveProperty("maxOutputTokens");
    });

    it("cannot have sampling override the model, instructions or tools", async () => {
      await delegate({
        instructions: "Stay on task.",
        sampling: { temperature: 0.2 },
      });

      expect(systemOf(streamArgs())).toContain("Stay on task.");
    });
  });

  describe("sub-agent tools", () => {
    it("opens its tools on invocation, not when the delegate is built", async () => {
      const loadTools = vi.fn().mockResolvedValue({
        tools: {},
        readOnlyToolNames: new Set(),
        gateScope: GATE_SCOPE,
      });
      const tool = delegateToolFor(buildOptions({ loadTools }));
      expect(loadTools).not.toHaveBeenCalled();

      const gen = tool.execute(
        { subAgent: "Research Agent", task: "Do something" },
        {} as ToolExecutionOptions<Record<string, unknown>>,
      ) as AsyncGenerator<SubAgentActivity>;
      for await (const _ of gen) void _;

      expect(loadTools).toHaveBeenCalledTimes(1);
    });

    it("reports a failure to open them to the parent as a tool error", async () => {
      await expect(
        delegate({
          loadTools: () => Promise.reject(new Error("MCP handshake failed")),
        }),
      ).rejects.toThrow(/MCP handshake failed/);
    });

    it("hands the delegated run the tools it opened", async () => {
      const bare = { description: "no execute" } as unknown as Tool;
      await delegate({ loadTools: toolsOf({ bare }) });

      expect(streamArgs().tools.bare).toBe(bare);
    });
  });

  describe("toModelOutput", () => {
    it("extracts text from activity output", () => {
      const tool = delegateToolFor(buildOptions());
      const result = tool.toModelOutput!({
        toolCallId: "tc1",
        input: { subAgent: "Research Agent", task: "test" },
        output: { entries: [], text: "Final answer" },
      });
      expect(result).toEqual({ type: "text", value: "Final answer" });
    });

    it("returns fallback when output has no text", () => {
      const tool = delegateToolFor(buildOptions());
      const result = tool.toModelOutput!({
        toolCallId: "tc1",
        input: { subAgent: "Research Agent", task: "test" },
        output: { entries: [] },
      });
      expect(result).toEqual({ type: "text", value: "Task completed." });
    });

    it("returns fallback when output is null", () => {
      const tool = delegateToolFor(buildOptions());
      const result = tool.toModelOutput!({
        toolCallId: "tc1",
        input: { subAgent: "Research Agent", task: "test" },
        output: null as unknown as SubAgentActivity,
      });
      expect(result).toEqual({ type: "text", value: "Task completed." });
    });
  });
});

describe("createDelegateTool — dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const twoDelegates = () => [
    createSubAgentDelegate(
      buildOptions({ id: "sa-1", name: "Research Agent" }),
    ),
    createSubAgentDelegate(buildOptions({ id: "sa-2", name: "Coder" })),
  ];

  const dispatch = async (
    tool: ReturnType<typeof createDelegateTool>,
    input: { subAgent: string; task?: string },
  ) => {
    const gen = tool.execute(
      { task: "Do something", ...input },
      {} as ToolExecutionOptions<Record<string, unknown>>,
    ) as AsyncGenerator<SubAgentActivity>;
    for await (const _ of gen) void _;
  };

  it("runs the named sub-agent, and only that one", async () => {
    const tool = createDelegateTool(twoDelegates());
    await dispatch(tool, { subAgent: "Coder", task: "Write a parser" });

    expect(streamTextSpy).toHaveBeenCalledTimes(1);
    expect(systemOf(streamArgs())).toContain('sub-agent named "Coder"');
    expect(streamArgs().prompt).toBe("Write a parser");
  });

  it("forgives case and surrounding whitespace in the target name", async () => {
    const tool = createDelegateTool(twoDelegates());
    await dispatch(tool, { subAgent: "  research agent " });

    expect(systemOf(streamArgs())).toContain(
      'sub-agent named "Research Agent"',
    );
  });

  it("fails with the valid targets when the sub-agent is unknown", async () => {
    const tool = createDelegateTool(twoDelegates());

    await expect(dispatch(tool, { subAgent: "Nobody" })).rejects.toThrow(
      /Unknown sub-agent "Nobody"\. The sub-agents you can delegate to are: "Research Agent", "Coder"\./,
    );
    expect(streamTextSpy).not.toHaveBeenCalled();
  });

  it("refuses a sub-agent that failed to resolve, with its recorded reason", async () => {
    const tool = createDelegateTool(
      [twoDelegates()[0]],
      new Map([
        ["coder", { name: "Coder", reason: "Model 'gpt-9' not found" }],
      ]),
    );

    await expect(dispatch(tool, { subAgent: "Coder" })).rejects.toThrow(
      /Sub-agent "Coder" is unavailable this turn: Model 'gpt-9' not found\. Do not retry it\. The sub-agents you can delegate to are: "Research Agent"\./,
    );
    expect(streamTextSpy).not.toHaveBeenCalled();
  });

  it("sends the model to the catalogue for the targets it accepts", () => {
    const tool = createDelegateTool(twoDelegates());
    expect(tool.description).toContain(
      "Sub-Agents section of your instructions",
    );
  });
});

describe("createDelegateTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const runTool = async (tools: Record<string, Tool>, subAgent: string) => {
    const gen = (
      tools[DELEGATE_TOOL_NAME] as unknown as {
        execute: (a: unknown, o: unknown) => AsyncGenerator<SubAgentActivity>;
      }
    ).execute({ subAgent, task: "Do something" }, {});
    for await (const _ of gen) void _;
  };

  const workingPlan = () =>
    vi.fn().mockResolvedValue({
      plan: { model: modelOf(step([])), maxSteps: DEFAULT_AGENT_MAX_STEPS },
      guardrails: null,
    });

  it("declares no delegation tool and no catalogue when there are no sub-agents", async () => {
    const result = await createDelegateTools([], vi.fn(), vi.fn());
    expect(result).toEqual({ tools: {}, catalogue: [], failures: [] });
  });

  it("declares exactly one tool however many sub-agents there are", async () => {
    const subAgents = [
      {
        id: "sa-1",
        name: "Research",
        description: "Looks things up",
        toolSetIds: ["ts1"],
      },
      { id: "sa-2", name: "Coder", toolSetIds: [] },
      { id: "sa-3", name: "Reviewer", toolSetIds: [] },
    ];

    const resolvePlan = workingPlan();
    const loadToolsFn = vi.fn().mockResolvedValue({
      tools: {},
      readOnlyToolNames: new Set(),
      gateScope: GATE_SCOPE,
    });

    const result = await createDelegateTools(
      subAgents,
      resolvePlan,
      loadToolsFn,
    );

    expect(Object.keys(result.tools)).toEqual([DELEGATE_TOOL_NAME]);
    expect(result.failures).toEqual([]);
    expect(resolvePlan).toHaveBeenCalledTimes(3);
    expect(result.catalogue).toEqual([
      { name: "Research", description: "Looks things up" },
      { name: "Coder", description: undefined },
      { name: "Reviewer", description: undefined },
    ]);

    expect(loadToolsFn).not.toHaveBeenCalled();

    await runTool(result.tools, "Research");
    expect(loadToolsFn).toHaveBeenCalledExactlyOnceWith("sa-1", ["ts1"]);

    await runTool(result.tools, "Research");
    expect(loadToolsFn).toHaveBeenCalledTimes(1);
  });

  it("forwards the resolved plan straight through to the sub-agent's run", async () => {
    const resolvePlan = vi.fn().mockResolvedValue({
      plan: { model: modelOf(step([])), maxSteps: 3, maxOutputTokens: 32000 },
      guardrails: null,
    });

    const { tools } = await createDelegateTools(
      [{ id: "sa-1", name: "Research" }],
      resolvePlan,
      vi.fn().mockResolvedValue({
        tools: {},
        readOnlyToolNames: new Set(),
        gateScope: GATE_SCOPE,
      }),
    );
    await runTool(tools, "Research");

    expect(streamArgs()).toMatchObject({ maxOutputTokens: 32000 });
    expect(stepCeilingOf()).toBe(3);
  });

  it("continues when a sub-agent fails to initialize, and reports it as a failure", async () => {
    const subAgents = [
      { id: "sa-1", name: "Failing" },
      { id: "sa-2", name: "Working" },
    ];

    const resolvePlan = vi
      .fn()
      .mockRejectedValueOnce(new Error("Model not found"))
      .mockResolvedValueOnce({
        plan: { model: modelOf(step([])), maxSteps: DEFAULT_AGENT_MAX_STEPS },
        guardrails: null,
      });

    const result = await createDelegateTools(
      subAgents,
      resolvePlan,
      vi.fn().mockResolvedValue({
        tools: {},
        readOnlyToolNames: new Set(),
        gateScope: GATE_SCOPE,
      }),
    );

    expect(result.catalogue).toEqual([
      { name: "Working", description: undefined },
    ]);
    expect(result.failures).toEqual([
      { id: "sa-1", name: "Failing", reason: "Model not found" },
    ]);
    await expect(runTool(result.tools, "Failing")).rejects.toThrow(
      /is unavailable this turn: Model not found/,
    );
  });

  it("drops every sub-agent in a name collision rather than picking a winner", async () => {
    const subAgents = [
      { id: "sa-1", name: "Helper" },
      { id: "sa-2", name: "helper " },
      { id: "sa-3", name: "Coder" },
    ];

    const resolvePlan = workingPlan();
    const result = await createDelegateTools(
      subAgents,
      resolvePlan,
      vi.fn().mockResolvedValue({
        tools: {},
        readOnlyToolNames: new Set(),
        gateScope: GATE_SCOPE,
      }),
    );

    expect(result.catalogue).toEqual([
      { name: "Coder", description: undefined },
    ]);
    expect(result.failures).toEqual([
      { id: "sa-1", name: "Helper", reason: COLLIDING_SUB_AGENT_NAME_REASON },
      { id: "sa-2", name: "helper ", reason: COLLIDING_SUB_AGENT_NAME_REASON },
    ]);
    expect(resolvePlan).toHaveBeenCalledTimes(1);
    await expect(runTool(result.tools, "Helper")).rejects.toThrow(
      /another sub-agent assigned to this agent has the same name/,
    );
  });

  it("declares no tool when every sub-agent failed", async () => {
    const result = await createDelegateTools(
      [{ id: "sa-1", name: "Failing" }],
      vi.fn().mockRejectedValue(new Error("Model not found")),
      vi.fn(),
    );

    expect(result.tools).toEqual({});
    expect(result.catalogue).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  it("refuses a sub-agent the caller already reported as unavailable, by id", async () => {
    const result = await createDelegateTools(
      [{ id: "sa-1", name: "Working" }],
      workingPlan(),
      vi.fn().mockResolvedValue({
        tools: {},
        readOnlyToolNames: new Set(),
        gateScope: GATE_SCOPE,
      }),
      undefined,
      [{ id: "sub-gone", reason: "not available in this workspace" }],
    );

    expect(result.failures).toEqual([
      { id: "sub-gone", reason: "not available in this workspace" },
    ]);
    await expect(runTool(result.tools, "sub-gone")).rejects.toThrow(
      /Sub-agent "sub-gone" is unavailable this turn: not available in this workspace/,
    );
  });

  it("passes each sub-agent's own resolved guardrails into its instructions", async () => {
    const resolvePlan = vi.fn().mockResolvedValue({
      plan: { model: modelOf(step([])), maxSteps: DEFAULT_AGENT_MAX_STEPS },
      guardrails: "Provider-specific rule.",
    });

    const { tools } = await createDelegateTools(
      [{ id: "sa-1", name: "Guarded", instructions: "You are guarded." }],
      resolvePlan,
      vi.fn().mockResolvedValue({
        tools: {},
        readOnlyToolNames: new Set(),
        gateScope: GATE_SCOPE,
      }),
    );
    await runTool(tools, "Guarded");

    const system = systemOf(streamArgs());
    expect(system).toContain("You are guarded.");
    expect(system).toContain("## Security and trust");
    expect(system).toContain("Provider-specific rule.");
  });
});
