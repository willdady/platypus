import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { Tool, ToolExecutionOptions } from "ai";
import { z } from "zod";
import {
  COLLIDING_SUB_AGENT_NAME_REASON,
  createDelegateTool,
  createDelegateTools,
  createSubAgentDelegate,
  type LoadedSubAgentTools,
  subAgentToolName,
  SUB_AGENT_STEP_LIMIT_NOTE,
  SUB_AGENT_TRUNCATION_NOTE,
} from "./sub-agent.ts";
import type { SubAgentActivity } from "./sub-agent.ts";
import { DELEGATE_TOOL_NAME } from "./turn-tool-names.ts";
import { runRegistry } from "../runs/run-registry.ts";
import { orgScope, workspaceScope, type WorkspaceScope } from "../scope.ts";
import { DEFAULT_AGENT_MAX_STEPS } from "@platypus/schemas";

// A delegated run now goes through the same pipeline a Chat turn does —
// `streamText` → `toUIMessageStream` → `readUIMessageStream` — so these tests
// drive a mock *model* and leave that pipeline real. The spy records what
// reached `streamText` without replacing it.
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

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "../logger.ts";

// --- Model harness -----------------------------------------------------------

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

/** Wraps a step's parts in the stream-start / finish envelope every step needs. */
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

/** A model that replays one step's parts per `doStream` call, in order. */
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

/** The scope a parent Chat turn would be running under. */
const parentScope: WorkspaceScope = workspaceScope(
  orgScope({ principal: { kind: "user", userId: "u1", name: "Ada" } }, "org-1"),
  "ws-1",
  true,
);

/**
 * A delegate's tools as the lazy loader it now takes: they are opened on first
 * invocation, so the option is a thunk rather than a resolved map. Carries no
 * read-only hints — a test that needs one builds `LoadedSubAgentTools`
 * directly.
 */
const toolsOf =
  (tools: Record<string, Tool>) => (): Promise<LoadedSubAgentTools> =>
    Promise.resolve({ tools, readOnlyToolNames: new Set() });

const baseOptions = {
  id: "agent-1",
  name: "Research Agent",
  loadTools: toolsOf({}),
};

/**
 * The pre-refactor option shape tests build with: `model`/`maxSteps`/
 * `securityGuardrails`/`sampling`/`maxOutputTokens` as loose named fields.
 * `buildOptions` folds them into the `plan`/`guardrails` shape
 * `createSubAgentDelegate` now takes, so individual test bodies below don't have
 * to restate that shape at every call site.
 */
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
      maxSteps,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...sampling,
    },
    guardrails: securityGuardrails,
  };
};

/**
 * The single `delegate` tool a parent gets when ONE sub-agent resolved. Every
 * exercise of a delegated run goes through the dispatcher rather than around
 * it, because the dispatcher is now the only way a model reaches one.
 */
const delegateToolFor = (
  options: Parameters<typeof createSubAgentDelegate>[0],
) => createDelegateTool([createSubAgentDelegate(options)]);

/** Build the delegate tool, run one delegation, collect every yield. */
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

/** The arguments the delegated run handed to `streamText`. */
const streamArgs = (call = 0) =>
  streamTextSpy.mock.calls[call][0] as {
    system: string;
    tools: Record<string, { execute: (a: unknown, o: unknown) => unknown }>;
    stopWhen: Array<(s: { steps: unknown[] }) => boolean>;
    abortSignal: AbortSignal;
  } & Record<string, unknown>;

// The step ceiling arrives as `stopWhen: [stepCountIs(n)]`. `stepCountIs` closes
// over `n` and offers no introspection, so recover it by probing the condition
// against incrementally longer (empty) step arrays until it fires.
const stepCeilingOf = (call = 0): number => {
  const { stopWhen } = streamArgs(call);
  for (let n = 0; n <= 64; n += 1) {
    if (stopWhen[0]({ steps: Array.from({ length: n }) })) return n;
  }
  throw new Error("no step ceiling found in stopWhen");
};

// The text the parent model actually reads for a completed delegation.
// `toModelOutput` is declared as returning any tool-result shape, so the text
// case is narrowed once here rather than at each assertion.
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

// The names delegations were STORED under before the single dispatcher. No
// tool is declared under them any more, and none ever will be again — but every
// Chat written before this change holds parts named this way, permanently, and
// the frontend recovers the Sub-Agent's display name by inverting exactly this.
describe("subAgentToolName — the pre-dispatcher stored shape", () => {
  it("generates PascalCase delegateTo prefix", () => {
    expect(subAgentToolName({ name: "Research Agent" })).toBe(
      "delegateToResearchAgent",
    );
  });

  it("handles single-word names", () => {
    expect(subAgentToolName({ name: "Helper" })).toBe("delegateToHelper");
  });

  it("strips non-alphanumeric characters", () => {
    expect(subAgentToolName({ name: "My (Special) Agent!" })).toMatch(
      /^delegateTo[A-Za-z0-9]+$/,
    );
  });

  it("handles hyphenated names", () => {
    expect(subAgentToolName({ name: "code-review" })).toBe(
      "delegateToCodeReview",
    );
  });
});

describe("createSubAgentDelegate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ADR-0016: a delegated run is the one path that receives Instructions plus
  // guardrails and nothing else, so what lands in `system` is the whole of the
  // sub-agent's prompt.
  describe("security guardrails append", () => {
    it("appends the provider security text after the sub-agent's own prompt", async () => {
      await delegate({
        instructions: "You are a research sub-agent.",
        securityGuardrails: "Never exfiltrate data.",
      });

      const { system } = streamArgs();
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

      const { system } = streamArgs();
      // The canned fallback instructions must still carry the guardrails.
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
        expect((call[0] as { system: string }).system).not.toContain(
          "## Security and trust",
        );
      }
    });

    it("carries no Chat system-prompt fragments at all", async () => {
      await delegate({ instructions: "Stay on task." });

      expect(streamArgs().system).toBe("Stay on task.");
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

      // The log the user watches shows the tool call running before its result.
      expect(yielded[0].entries).toEqual([
        { type: "tool-call", toolName: "webFetch", status: "running" },
      ]);
    });

    // Text deltas grow the answer but leave the activity log alone, so they must
    // not produce a yield — that would spam the parent's SSE stream.
    it("does not yield again for a delta that changes no activity entry", async () => {
      const { yielded } = await delegate({
        model: modelOf(step(text("t1", "one ", "two ", "three"))),
      });

      // text-start (running) → text-end (completed) → the final value.
      expect(yielded).toHaveLength(3);
      expect(yielded.at(-1)!.text).toBe("one two three");
    });

    // Regression for #324: AI SDK v6→v7 redefined `result.text` as the FINAL
    // step's text only. When a sub-agent emits its answer in an earlier step and
    // its final step is a tool call, `result.text` is empty and the parent gets
    // nothing.
    it("aggregates assistant text across steps, not just the final step's", async () => {
      const { yielded } = await delegate({
        model: modelOf(
          step([...text("t1", "Here are ", "the boards.")], {
            unified: "tool-calls",
          }),
          // Nothing but the tool call in step 1; the final step carries no text.
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

      // Not silently empty — carries the tool name and the result payload so the
      // parent can still relay something meaningful.
      const final = yielded.at(-1)!;
      expect(final.text).toContain("listBoards");
      expect(final.text).toContain("Board One");
    });

    // A stream `error` part ends the stream normally, so before this the
    // generator returned whatever text had accumulated — usually the model's
    // opening preamble — and the parent read the crash as the answer.
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

    // Issue #421: the activity entry keeps only the error text, so a sub-agent
    // run — the least observable surface there is — recorded nothing about the
    // arguments the model actually emitted. It now goes through the same
    // instrumentation the Chat path uses, tagged with the sub-agent.
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

      // The same message the run driver logs, so an Operator greps once and
      // the sub-agent fields say which run it came from.
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

  // The delegated run is a run in its own right: it holds its own registry
  // entry, its own timers, and its own abort signal — and the parent's
  // cancellation reaches it through the registry.
  describe("run lifecycle", () => {
    it("generates with its own abort signal rather than the parent's", async () => {
      const parent = new AbortController();
      await delegate({}, { abortSignal: parent.signal });

      const { abortSignal } = streamArgs();
      expect(abortSignal).toBeInstanceOf(AbortSignal);
      expect(abortSignal).not.toBe(parent.signal);
    });

    // A Trigger run is started under bounds an Operator configured; work it
    // delegates has to run under the same ones, not the process defaults.
    it("registers under the bounds the parent run was started with", async () => {
      const register = vi.spyOn(runRegistry, "register");
      await delegate({
        parentRun: {
          runId: "parent-1",
          scope: parentScope,
          timeouts: { perStepTimeoutMs: 600_000, perRunTimeoutMs: 3_600_000 },
        },
      });

      expect(register.mock.calls.at(-1)?.[1]).toMatchObject({
        perStepTimeoutMs: 600_000,
        perRunTimeoutMs: 3_600_000,
      });
      register.mockRestore();
    });

    // Issue #496: a delegated run is unattended, so it drives under the same
    // no-progress stop condition a Trigger run has — a stuck model re-issuing
    // the same call for the same result is aborted rather than burning compute
    // up to the step ceiling. An interactive Chat turn leaves that off.
    it("drives the delegated run with the no-progress stop condition", async () => {
      await delegate({});

      const { stopWhen } = streamArgs();
      // Step ceiling (stepCountIs) + the no-progress detector.
      expect(stopWhen).toHaveLength(2);
    });

    // The generator body doesn't start until the consumer pulls, so a parent
    // cancelled between dispatch and the first tick would never fire the abort
    // listener and the delegation would run on regardless.
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

  // Issue #442. A token-limit stop is neither an error nor an abort: the stream
  // ends normally and the partial answer was returned as if it were the whole
  // finding. The parent has to be told it is looking at a fragment.
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
      // Not a failure: the partial answer is real work and still comes back.
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
        // The provider's own word for the stop, which the unified reason
        // would otherwise be the only record of.
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

    // The same rule the run path applies: a step inside the tool loop can end at
    // the ceiling and the sub-agent still recover and answer in full.
    it("ignores a step that ended at the limit mid tool-loop", async () => {
      const { yielded } = await delegate({
        model: modelOf(
          step(toolCall("tc1", "listCards", "{}"), {
            unified: "length",
            raw: "max_tokens",
          }),
          step(text("t1", "One card.")),
        ),
        loadTools: toolsOf({
          listCards: {
            inputSchema: z.object({}),
            execute: () => Promise.resolve([{ id: "c1" }]),
          },
        }),
      });

      expect(yielded.at(-1)!).not.toHaveProperty("truncatedByTokenLimit");
      expect(yielded.at(-1)!.text).toBe("One card.");
    });

    // A cutoff is a fact about the answer, not an activity step, so the log the
    // user watches must not gain a spurious row (or a spurious yield).
    it("adds no activity entry and no extra yield for the terminal finish", async () => {
      const { yielded } = await delegate({ model: truncated() });

      // text-start yields once; the delta and the finish yield nothing; then
      // the final value.
      expect(yielded).toHaveLength(3);
      expect(yielded.at(-1)!.entries).toHaveLength(1);
    });

    // A stream that fails after hitting the ceiling is still a failure: the
    // parent must get a tool error, not a flagged partial answer.
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

  // Issue #540. The other way a delegation comes back unfinished: its loop ran
  // out of steps while the model was still asking to continue. The card showed
  // the fragment as though it were the finding, and the parent read it the same
  // way.
  describe("stopped at the step ceiling", () => {
    /** A delegate that spends its only allowed step on a tool call. */
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
      // Its own wording, not the output-ceiling note's: the two stops have
      // different causes and a parent that reads one for the other would
      // delegate the wrong remedy.
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

    // The ceiling was reached but the last allowed step was the answer, so
    // nothing was cut short.
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

  // An Agent must generate with the parameters assigned to it wherever it runs.
  // Before this, a delegated run passed only model/instructions/tools/stopWhen,
  // so an Agent's Temperature was inert the moment it was used as a sub-agent.
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

    // The ceiling is not a sampling parameter — it comes off the sub-agent's
    // OWN Provider model entry, not its Agent row (issue #454). Without it a
    // delegated run truncates one level down, on Bedrock especially, with the
    // Org Admin's declared ceiling applying only to the parent turn.
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

      expect(streamArgs().system).toContain("Stay on task.");
    });
  });

  // A delegate's tools are opened when it is invoked, not when it is built, so
  // a parent that never delegates opens none of their MCP connections. Results
  // arrive already normalized — the Tool session that loads them owns that
  // (#321 one level down), which is why this wrapper no longer touches them.
  describe("sub-agent tools", () => {
    it("opens its tools on invocation, not when the delegate is built", async () => {
      const loadTools = vi
        .fn()
        .mockResolvedValue({ tools: {}, readOnlyToolNames: new Set() });
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

  /** Two named delegates over the same trivial model, for routing tests. */
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

    // One delegated run, and its prompt is the task it was given.
    expect(streamTextSpy).toHaveBeenCalledTimes(1);
    expect(streamArgs().system).toContain('sub-agent named "Coder"');
    expect(streamArgs().prompt).toBe("Write a parser");
  });

  it("forgives case and surrounding whitespace in the target name", async () => {
    const tool = createDelegateTool(twoDelegates());
    await dispatch(tool, { subAgent: "  research agent " });

    expect(streamArgs().system).toContain('sub-agent named "Research Agent"');
  });

  // The parent turn survives this: the model gets a tool error it can act on,
  // and nothing is delegated. Falling through to an arbitrary sub-agent — the
  // one thing this must never do — would show up as a stream call here.
  it("fails with the valid targets when the sub-agent is unknown", async () => {
    const tool = createDelegateTool(twoDelegates());

    await expect(dispatch(tool, { subAgent: "Nobody" })).rejects.toThrow(
      /Unknown sub-agent "Nobody"\. The sub-agents you can delegate to are: "Research Agent", "Coder"\./,
    );
    expect(streamTextSpy).not.toHaveBeenCalled();
  });

  // Under one tool the tool always exists, so a sub-agent that failed to
  // resolve is refused HERE rather than by its tool being absent.
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

  /** Run the one tool a builder produced against a named sub-agent. */
  const runTool = async (tools: Record<string, Tool>, subAgent: string) => {
    const gen = (
      tools[DELEGATE_TOOL_NAME] as unknown as {
        execute: (a: unknown, o: unknown) => AsyncGenerator<SubAgentActivity>;
      }
    ).execute({ subAgent, task: "Do something" }, {});
    for await (const _ of gen) void _;
  };

  /**
   * A `resolvePlan` stub, standing in for the production wiring —
   * `(subAgent) => resolveGenerationPlan({ agent: subAgent }, scope, queries)`.
   * Resolution itself (model, step ceiling, output ceiling, sampling, alias
   * lookup) is `resolveGenerationPlan`'s own contract, unit-tested in
   * `runs/agent-plan.test.ts`; this suite only has to prove
   * `createDelegateTools` calls it once per sub-agent, forwards its result
   * unmodified, and keeps going when it rejects.
   */
  const workingPlan = () =>
    vi.fn().mockResolvedValue({
      plan: { model: modelOf(step([])), maxSteps: DEFAULT_AGENT_MAX_STEPS },
      guardrails: null,
    });

  it("declares no delegation tool and no catalogue when there are no sub-agents", async () => {
    const result = await createDelegateTools([], vi.fn(), vi.fn());
    expect(result).toEqual({ tools: {}, catalogue: [], failures: [] });
  });

  // The whole point of the dispatcher: the tool count no longer tracks the
  // sub-agent count.
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
    const loadToolsFn = vi
      .fn()
      .mockResolvedValue({ tools: {}, readOnlyToolNames: new Set() });

    const result = await createDelegateTools(
      subAgents,
      resolvePlan,
      loadToolsFn,
    );

    expect(Object.keys(result.tools)).toEqual([DELEGATE_TOOL_NAME]);
    expect(result.failures).toEqual([]);
    expect(resolvePlan).toHaveBeenCalledTimes(3);
    // The catalogue is what the prompt advertises: every resolvable sub-agent,
    // by the name the tool expects back, with its description.
    expect(result.catalogue).toEqual([
      { name: "Research", description: "Looks things up" },
      { name: "Coder", description: undefined },
      { name: "Reviewer", description: undefined },
    ]);

    // Building the delegates opens nothing: each sub-agent's tools are loaded
    // if and when the parent actually delegates to it.
    expect(loadToolsFn).not.toHaveBeenCalled();

    await runTool(result.tools, "Research");
    expect(loadToolsFn).toHaveBeenCalledExactlyOnceWith("sa-1", ["ts1"]);

    // Memoized per delegate: a second delegation in the same turn reuses the
    // tools — and the connections — the first one opened.
    await runTool(result.tools, "Research");
    expect(loadToolsFn).toHaveBeenCalledTimes(1);
  });

  // `resolvePlan`'s result rides straight through to the sub-agent's run —
  // this function no longer re-derives any of it (issue #454's output ceiling
  // included), which is the whole point of routing every caller through the
  // one resolver.
  it("forwards the resolved plan straight through to the sub-agent's run", async () => {
    const resolvePlan = vi.fn().mockResolvedValue({
      plan: { model: modelOf(step([])), maxSteps: 3, maxOutputTokens: 32000 },
      guardrails: null,
    });

    const { tools } = await createDelegateTools(
      [{ id: "sa-1", name: "Research" }],
      resolvePlan,
      vi.fn().mockResolvedValue({ tools: {}, readOnlyToolNames: new Set() }),
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
      vi.fn().mockResolvedValue({ tools: {}, readOnlyToolNames: new Set() }),
    );

    // Advertised: only the one that resolved.
    expect(result.catalogue).toEqual([
      { name: "Working", description: undefined },
    ]);
    // The dropped sub-agent must come back named, so the caller can describe
    // it as unavailable rather than leave the model to discover the gap.
    expect(result.failures).toEqual([
      { id: "sa-1", name: "Failing", reason: "Model not found" },
    ]);
    // And the tool refuses it by name, with that same reason.
    await expect(runTool(result.tools, "Failing")).rejects.toThrow(
      /is unavailable this turn: Model not found/,
    );
  });

  // Two sub-agents sharing a name have no unambiguous target between them, so
  // BOTH are dropped and reported. Previously one silently won.
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
      vi.fn().mockResolvedValue({ tools: {}, readOnlyToolNames: new Set() }),
    );

    expect(result.catalogue).toEqual([
      { name: "Coder", description: undefined },
    ]);
    expect(result.failures).toEqual([
      { id: "sa-1", name: "Helper", reason: COLLIDING_SUB_AGENT_NAME_REASON },
      { id: "sa-2", name: "helper ", reason: COLLIDING_SUB_AGENT_NAME_REASON },
    ]);
    // Neither was built, so neither cost a plan resolution.
    expect(resolvePlan).toHaveBeenCalledTimes(1);
    await expect(runTool(result.tools, "Helper")).rejects.toThrow(
      /another sub-agent assigned to this agent has the same name/,
    );
  });

  // A tool that can only ever error is worth nothing to the model; the prompt's
  // unavailable section still says what happened.
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

  // The caller knows about assignments whose row never resolved in the
  // Workspace before the factory is called. They have no name — reading one off
  // the row is the boundary crossing that dropped them — so the id the prompt
  // lists them under is the identifier the tool refuses them by.
  it("refuses a sub-agent the caller already reported as unavailable, by id", async () => {
    const result = await createDelegateTools(
      [{ id: "sa-1", name: "Working" }],
      workingPlan(),
      vi.fn().mockResolvedValue({ tools: {}, readOnlyToolNames: new Set() }),
      undefined,
      [{ id: "sub-gone", reason: "not available in this workspace" }],
    );

    // Reported back alongside the factory's own failures, so the caller has one
    // list to render.
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
      vi.fn().mockResolvedValue({ tools: {}, readOnlyToolNames: new Set() }),
    );
    await runTool(tools, "Guarded");

    const { system } = streamArgs();
    expect(system).toContain("You are guarded.");
    expect(system).toContain("## Security and trust");
    expect(system).toContain("Provider-specific rule.");
  });
});
