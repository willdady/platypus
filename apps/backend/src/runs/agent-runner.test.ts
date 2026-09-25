import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

/**
 * As much of a stream part as the metadata extractor reads. The SDK hands it
 * the full `TextStreamPart` union; these tests hand it the fields the part
 * they are standing in for would carry.
 */
type MetadataPart = {
  type: string;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
};

const {
  mockPrepareChatTurn,
  mockValidateTurnAttachments,
  mockStreamText,
  streamHarness,
} = vi.hoisted(() => {
  // A minimal, manually-driven async iterable standing in for the server-side
  // snapshot branch of the UI message stream. The test pushes partial
  // messages and ends it explicitly so timing is deterministic.
  class AsyncQueue {
    items: unknown[] = [];
    resolvers: ((r: { value: unknown; done: boolean }) => void)[] = [];
    ended = false;
    push(item: unknown) {
      const r = this.resolvers.shift();
      if (r) r({ value: item, done: false });
      else this.items.push(item);
    }
    end() {
      this.ended = true;
      let r;
      while ((r = this.resolvers.shift())) r({ value: undefined, done: true });
    }
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (this.items.length)
            return Promise.resolve({
              value: this.items.shift(),
              done: false,
            });
          if (this.ended)
            return Promise.resolve({ value: undefined, done: true });
          return new Promise((res) => this.resolvers.push(res));
        },
      };
    }
  }
  return {
    mockPrepareChatTurn: vi.fn(),
    mockValidateTurnAttachments: vi.fn(),
    mockStreamText: vi.fn(),
    streamHarness: {
      AsyncQueue,
      queue: null as InstanceType<typeof AsyncQueue> | null,
      // The AI SDK callbacks the runner registers; captured so the test can
      // drive step-completion and stream-completion by hand.
      onStepFinish: undefined as ((step: unknown) => void) | undefined,
      onFinish: undefined as
        ((ctx: { messages: unknown[] }) => Promise<void> | void) | undefined,
      // Fires once per completed tool execution; the runner folds these into
      // the finished messages.
      onToolExecutionEnd: undefined as
        | ((ctx: {
            toolCall: { toolCallId: string };
            toolExecutionMs: number;
          }) => void)
        | undefined,
      // `toUIMessageStream`'s metadata extractor. The SDK calls it per stream
      // part; the tests call it by hand with the part they care about.
      messageMetadata: undefined as
        ((opts: { part: MetadataPart }) => unknown) | undefined,
      responseSentinel: { __isResponse: true },
    },
  };
});

vi.mock("../services/chat-execution.ts", () => ({
  prepareChatTurn: mockPrepareChatTurn,
  validateTurnAttachments: mockValidateTurnAttachments,
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    streamText: mockStreamText,
    convertToModelMessages: vi.fn().mockReturnValue([]),
    createIdGenerator: vi.fn().mockReturnValue(() => "msg-1"),
    stepCountIs: vi.fn(),
    readUIMessageStream: () => streamHarness.queue,
    createUIMessageStreamResponse: () => streamHarness.responseSentinel,
  };
});

import { convertToModelMessages } from "ai";
import { AgentRunner } from "./agent-runner.ts";
import { ConflictError } from "../errors.ts";
import { logger } from "../logger.ts";
import { runRegistry, TimeoutError } from "./run-registry.ts";
import { openToolSession } from "../tools/tool-session.ts";
import type { ResolvedRunPlan, RunInput, RunSink, RunStats } from "./types.ts";
import type { WorkspaceScope } from "../scope.ts";
import { RunEventRecorder } from "./run-events.ts";

type LifecycleEvent =
  | {
      name: "onStart";
      runId: string;
      messages?: unknown[];
      events?: RunEventRecorder;
    }
  | { name: "onResolved"; runId: string; plan: ResolvedRunPlan }
  | { name: "onProgress"; runId: string }
  | {
      name: "onFinish";
      runId: string;
      status: string;
      error?: string;
      messages?: unknown[];
      stats?: RunStats;
      finalText?: string;
    };

class RecordingSink implements RunSink {
  events: LifecycleEvent[] = [];

  onStart(ctx: {
    runId: string;
    messages?: unknown[];
    events?: RunEventRecorder;
  }): Promise<void> {
    this.events.push({
      name: "onStart",
      runId: ctx.runId,
      messages: ctx.messages,
      events: ctx.events,
    });
    return Promise.resolve();
  }
  onResolved(ctx: { runId: string; plan: ResolvedRunPlan }): Promise<void> {
    this.events.push({ name: "onResolved", runId: ctx.runId, plan: ctx.plan });
    return Promise.resolve();
  }
  onProgress(ctx: { runId: string }): Promise<void> {
    this.events.push({ name: "onProgress", runId: ctx.runId });
    return Promise.resolve();
  }
  onFinish(ctx: {
    runId: string;
    status: string;
    error?: Error;
    messages?: unknown[];
    stats?: RunStats;
    finalText?: string;
  }): Promise<void> {
    this.events.push({
      name: "onFinish",
      runId: ctx.runId,
      status: ctx.status,
      error: ctx.error?.message,
      messages: ctx.messages,
      stats: ctx.stats,
      finalText: ctx.finalText,
    });
    return Promise.resolve();
  }

  names(): string[] {
    return this.events.map((e) => e.name);
  }

  /** The stats the run handed the sink at termination. */
  finalStats(): RunStats | undefined {
    const finish = this.events.find((e) => e.name === "onFinish");
    return finish?.name === "onFinish" ? finish.stats : undefined;
  }
}

const scope: WorkspaceScope = {
  orgId: "org-1",
  workspaceId: "ws-1",
  isWorkspaceOwner: true,
  principal: { kind: "user", userId: "user-1", name: "Alice" },
};

const baseInput: RunInput = {
  runId: "run-1",
  request: { agentId: "agent-1" },
  messages: [],
  memoriesReferenceDate: new Date("2026-05-03T12:00:00Z"),
};

const fakeTurn = (overrides?: { dispose?: () => Promise<void> }) => {
  const dispose = overrides?.dispose ?? vi.fn().mockResolvedValue(undefined);
  return {
    stream: {
      model: { _sentinel: "model" },
      tools: {},
      system: "system prompt",
      messages: [],
      maxSteps: 1,
    },
    resolved: {
      agentId: "agent-1",
      providerId: "p1",
      modelId: "m1",
    },
    dispose,
  };
};

const fakeGenerateResult = {
  text: "ok",
  steps: [],
  totalUsage: { inputTokens: 10, outputTokens: 5 },
};

/**
 * What the headless drive reads off a `streamText` result: a UI message stream
 * it drains (empty here — these tests drive the callbacks by hand) and the
 * promise-valued terminal fields. `settleAfter`, when given, gates every field
 * on it, so a test can make the model "hang" until a signal fires and fail the
 * fields with that signal's reason.
 */
const streamResultOf = (
  data: {
    text?: string;
    steps?: unknown[];
    totalUsage?: unknown;
    finishReason?: string;
    rawFinishReason?: string;
  },
  opts: { settleAfter?: Promise<unknown> } = {},
) => {
  const gate = opts.settleAfter ?? Promise.resolve();
  const after = <T>(value: T) => gate.then(() => value);
  return {
    toUIMessageStream: () => emptyUIStream(),
    text: after(data.text ?? "ok"),
    steps: after(data.steps ?? []),
    totalUsage: after(data.totalUsage ?? {}),
    finishReason: after(data.finishReason ?? "stop"),
    rawFinishReason: after(data.rawFinishReason ?? "stop"),
  };
};

/** A model that hangs until `signal` aborts, then fails with its reason. */
const hangingUntilAbort = ({ abortSignal }: { abortSignal: AbortSignal }) =>
  streamResultOf(fakeGenerateResult, {
    settleAfter: new Promise<never>((_, reject) => {
      if (abortSignal.aborted) {
        reject(abortSignal.reason ?? new Error("aborted"));
        return;
      }
      abortSignal.addEventListener("abort", () =>
        reject(abortSignal.reason ?? new Error("aborted")),
      );
    }),
  });

// Issue #406: a step that ended at the output ceiling, or that the provider
// rejected as a malformed tool use, used to log identically to a clean one.
// The unified reason alone is not enough — it is exactly what collapses
// Bedrock's `malformed_tool_use` into `other`, so the raw value must survive.
describe("finish reason instrumentation", () => {
  let runner: AgentRunner;
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
  });

  const stepLogs = () =>
    vi
      .mocked(logger.info)
      .mock.calls.filter((call) => call[1] === "Step finished")
      .map((call) => call[0] as Record<string, unknown>);

  // The raw value is the point: an unrecognised provider reason collapses to
  // `other` in the unified union and is otherwise unrecoverable.
  it.each([
    ["tool-calls", "tool_use"],
    ["other", "malformed_tool_use"],
  ])(
    "logs the unified (%s) and the raw (%s) finish reason for a step",
    async (finishReason, rawFinishReason) => {
      mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
      mockStreamText.mockImplementationOnce(
        (args: { onStepFinish: (s: unknown) => void }) => {
          args.onStepFinish({
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason,
            rawFinishReason,
          });
          return streamResultOf(fakeGenerateResult);
        },
      );

      await runner.generate({
        scope,
        input: baseInput,
        sink: new RecordingSink(),
      });

      expect(stepLogs()[0]).toMatchObject({ finishReason, rawFinishReason });
    },
  );

  it("warns when a step stops at the output token limit", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockImplementationOnce(
      (args: { onStepFinish: (s: unknown) => void }) => {
        args.onStepFinish({
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: "length",
          rawFinishReason: "max_tokens",
        });
        return streamResultOf(fakeGenerateResult);
      },
    );

    await runner.generate({
      scope,
      input: baseInput,
      sink: new RecordingSink(),
    });

    const warned = vi
      .mocked(logger.warn)
      .mock.calls.some((call) => /truncated/i.test(String(call[1])));
    expect(warned).toBe(true);
  });

  // The unattended path returns its text to a caller that discards it, so the
  // stats the sink persists are the only place a cut-short run can be recorded.
  it("flags the stats when an unattended run stopped at the output limit", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockReturnValueOnce(
      streamResultOf({
        ...fakeGenerateResult,
        text: "half an ans",
        finishReason: "length",
        rawFinishReason: "max_tokens",
      }),
    );
    const sink = new RecordingSink();

    const result = await runner.generate({ scope, input: baseInput, sink });

    expect(sink.finalStats()?.truncatedByTokenLimit).toBe(true);
    expect(result.stats.truncatedByTokenLimit).toBe(true);
    // The answer itself is returned as the model wrote it — no appended notice.
    expect(result.text).toBe("half an ans");
  });

  it("leaves a cleanly finished unattended run's stats unflagged", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockReturnValueOnce(
      streamResultOf({
        ...fakeGenerateResult,
        finishReason: "stop",
        rawFinishReason: "end_turn",
      }),
    );
    const sink = new RecordingSink();

    const result = await runner.generate({ scope, input: baseInput, sink });

    expect(sink.finalStats()).not.toHaveProperty("truncatedByTokenLimit");
    expect(result.text).toBe("ok");
  });

  it("records the finish reasons on the unattended completion log", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockReturnValueOnce(
      streamResultOf({
        ...fakeGenerateResult,
        finishReason: "stop",
        rawFinishReason: "end_turn",
      }),
    );

    await runner.generate({
      scope,
      input: baseInput,
      sink: new RecordingSink(),
    });

    const completed = vi
      .mocked(logger.info)
      .mock.calls.find((call) => call[1] === "Run generate completed");
    expect(completed?.[0]).toMatchObject({
      finishReason: "stop",
      rawFinishReason: "end_turn",
    });
  });
});

// Issue #421: the finish reason says a tool call was rejected, not what the
// model emitted. Both run paths record `tool-error` parts into step content,
// so both are covered from the one step-finished callback.
describe("rejected tool input instrumentation", () => {
  let runner: AgentRunner;
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
    streamHarness.queue = null;
    streamHarness.onStepFinish = undefined;
    streamHarness.onFinish = undefined;
  });

  const failureLogs = () =>
    vi
      .mocked(logger.debug)
      .mock.calls.filter((call) => call[1] === "Tool call failed")
      .map((call) => call[0] as Record<string, unknown>);

  const stepWith = (content: unknown[]) => ({
    toolCalls: [{ toolName: "writeFile" }],
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "tool-calls",
    rawFinishReason: "tool_use",
    content,
  });

  const generateWithStep = async (content: unknown[]) => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockImplementationOnce(
      (args: { onStepFinish: (s: unknown) => void }) => {
        args.onStepFinish(stepWith(content));
        return streamResultOf(fakeGenerateResult);
      },
    );
    await runner.generate({
      scope,
      input: baseInput,
      sink: new RecordingSink(),
    });
  };

  it("records a truncated payload on the unattended path", async () => {
    const raw = '{"path":"notes.md","body":"the first half of a very l';
    await generateWithStep([
      {
        type: "tool-error",
        toolCallId: "call_1",
        toolName: "writeFile",
        input: raw,
        error: "AI_InvalidToolInputError: Invalid input for tool writeFile",
      },
    ]);

    expect(failureLogs()[0]).toMatchObject({
      runId: "run-1",
      step: 1,
      toolCallId: "call_1",
      toolName: "writeFile",
      inputType: "string",
      inputKind: "unparseable",
      inputLength: raw.length,
      inputPrefix: raw,
    });
  });

  it("tells a payload the model never sent from one it sent empty", async () => {
    await generateWithStep([
      { type: "tool-error", toolCallId: "call_1", input: "" },
      { type: "tool-error", toolCallId: "call_2", input: {} },
    ]);

    expect(failureLogs().map((r) => r.inputKind)).toEqual(["empty", "parsed"]);
  });

  it("says nothing about a step whose tool calls all succeeded", async () => {
    await generateWithStep([
      { type: "text", text: "done" },
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "writeFile",
        input: { path: "notes.md", body: "secret" },
        output: { ok: true },
      },
    ]);

    expect(failureLogs()).toEqual([]);
  });

  it("records the same payload on the streaming path", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    streamHarness.queue = new streamHarness.AsyncQueue();
    mockStreamText.mockImplementation(
      (opts: { onStepFinish: (step: unknown) => void }) => {
        streamHarness.onStepFinish = opts.onStepFinish;
        return {
          toUIMessageStream: () => emptyUIStream(),
        };
      },
    );

    await runner.stream({
      scope,
      input: { ...baseInput, runId: "s-rejected" },
      sink: new RecordingSink(),
      options: { origin: "http://test" },
    });
    streamHarness.onStepFinish!(
      stepWith([
        {
          type: "tool-error",
          toolCallId: "call_1",
          toolName: "updateNotification",
          input: { message: "far too long" },
          error: "AI_InvalidToolInputError",
        },
      ]),
    );

    expect(failureLogs()[0]).toMatchObject({
      runId: "s-rejected",
      toolName: "updateNotification",
      inputKind: "parsed",
      inputPrefix: '{"message":"far too long"}',
    });
    runRegistry.cancel("s-rejected");
  });

  it("keeps the argument text out of the entry an Operator sees by default", async () => {
    await generateWithStep([
      { type: "tool-error", toolCallId: "call_1", input: '{"body":"cut' },
    ]);

    // Emitted at `debug` alone: at the default LOG_LEVEL=info the payload is
    // never written at all.
    const higher = [
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
    ];
    expect(higher.some((call) => JSON.stringify(call[0]).includes("cut"))).toBe(
      false,
    );
  });
});

describe("AgentRunner.generate", () => {
  let runner: AgentRunner;
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
  });

  // #647: a headless run's Run timeline. The runner owns the recorder — one per
  // run — and hands it to the sink at start, so the sink can flush events on
  // its own cadence, and to the drive, which fills it.
  it("hands the sink a Run event recorder for this run at start", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockReturnValueOnce(streamResultOf(fakeGenerateResult));

    const sink = new RecordingSink();
    await runner.generate({
      scope,
      input: { ...baseInput, runId: "events-1" },
      sink,
    });

    const start = sink.events[0] as Extract<
      LifecycleEvent,
      { name: "onStart" }
    >;
    expect(start.events).toBeInstanceOf(RunEventRecorder);
    expect(start.events?.runId).toBe("events-1");
  });

  it("hands the sink the final assistant text at finish", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockReturnValueOnce(
      streamResultOf({ ...fakeGenerateResult, text: "The conclusion." }),
    );

    const sink = new RecordingSink();
    await runner.generate({ scope, input: baseInput, sink });

    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.finalText).toBe("The conclusion.");
  });

  it("runs the full lifecycle on success and disposes the turn", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn({ dispose }));
    mockStreamText.mockReturnValueOnce(streamResultOf(fakeGenerateResult));

    const sink = new RecordingSink();
    const result = await runner.generate({ scope, input: baseInput, sink });

    expect(sink.names()).toEqual(["onStart", "onResolved", "onFinish"]);
    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("succeeded");
    expect(finish.error).toBeUndefined();
    expect(result.text).toBe("ok");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  // ADR-0018: an unattended run's only record of how full the context got is
  // the stats it hands the sink, and the two plausible-looking figures beside
  // occupancy — `totalUsage.inputTokens` and the accumulated `stats.inputTokens`
  // — are both cross-step sums.
  it("records Context occupancy from the final step, not the sum across steps", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockReturnValueOnce(
      streamResultOf({
        text: "ok",
        steps: [
          { toolCalls: [], usage: { inputTokens: 1_000, outputTokens: 40 } },
          { toolCalls: [], usage: { inputTokens: 3_500, outputTokens: 60 } },
        ],
        totalUsage: { inputTokens: 4_500, outputTokens: 100 },
      }),
    );

    const sink = new RecordingSink();
    const result = await runner.generate({ scope, input: baseInput, sink });

    expect(result.stats.contextOccupancy).toBe(3_500);
    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.stats?.contextOccupancy).toBe(3_500);
    // The billing sums keep their existing meaning.
    expect(finish.stats?.inputTokens).toBe(4_500);
    expect(finish.stats?.outputTokens).toBe(100);
  });

  // The interim stats a long run flushes mid-flight are what the Operator reads
  // while it is still going, so a step that reports nothing must not leave an
  // earlier, smaller step's figure looking current.
  it("clears the interim occupancy when a step reports no usage", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    const progressed: Array<number | undefined> = [];
    mockStreamText.mockImplementationOnce(
      ({ onStepFinish }: { onStepFinish: (s: unknown) => void }) => {
        onStepFinish({
          toolCalls: [],
          usage: { inputTokens: 1_000, outputTokens: 40 },
        });
        onStepFinish({ toolCalls: [] });
        return streamResultOf({
          text: "ok",
          steps: [{ toolCalls: [] }],
          totalUsage: {},
        });
      },
    );

    const sink = new RecordingSink();
    const recorded = sink.onProgress.bind(sink);
    // Read at call time: the runner passes one mutated stats object every time,
    // so the figure has to be copied out as each flush happens.
    sink.onProgress = (ctx: { runId: string; stats?: RunStats }) => {
      progressed.push(ctx.stats?.contextOccupancy);
      return recorded(ctx);
    };
    await runner.generate({ scope, input: baseInput, sink });

    expect(progressed).toEqual([1_000, undefined]);
  });

  it("records no occupancy when the Provider reports no usage", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockReturnValueOnce(
      streamResultOf({
        text: "ok",
        steps: [{ toolCalls: [] }],
        totalUsage: {},
      }),
    );

    const sink = new RecordingSink();
    const result = await runner.generate({ scope, input: baseInput, sink });

    // Unknown stays unknown: nothing is estimated, and 0 would read as a
    // measurement of an empty context.
    expect(result.stats.contextOccupancy).toBeUndefined();
  });

  it("invariant: reaches onFinish even when prepareChatTurn throws", async () => {
    mockPrepareChatTurn.mockRejectedValueOnce(new Error("Agent not found"));

    const sink = new RecordingSink();
    await expect(
      runner.generate({ scope, input: baseInput, sink }),
    ).rejects.toThrow("Agent not found");

    expect(sink.names()).toEqual(["onStart", "onFinish"]);
    const finish = sink.events[1] as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("failed");
    expect(finish.error).toBe("Agent not found");
    // Generate model was never invoked
    expect(mockStreamText).not.toHaveBeenCalled();
  });

  it("invariant: reaches onFinish and disposes the turn when generateText throws", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn({ dispose }));
    mockStreamText.mockImplementationOnce(() => {
      throw new Error("Model error");
    });

    const sink = new RecordingSink();
    await expect(
      runner.generate({ scope, input: baseInput, sink }),
    ).rejects.toThrow("Model error");

    expect(sink.names()).toEqual(["onStart", "onResolved", "onFinish"]);
    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("failed");
    expect(finish.error).toBe("Model error");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  // Only a person at the keyboard gets an interactive turn; a Trigger run and a
  // delegate resolve headless, on behalf of the human who owns them.
  it.each([
    [
      "a user",
      { kind: "user", userId: "user-1", name: "Alice" },
      { id: "user-1", name: "Alice" },
      "interactive",
    ],
    [
      "a Trigger",
      {
        kind: "trigger",
        triggerId: "t1",
        onBehalfOfUserId: "owner-1",
        name: "Owner",
      },
      { id: "owner-1", name: "Owner" },
      "headless",
    ],
    [
      "a delegated sub-Agent",
      {
        kind: "subAgent",
        parentRunId: "parent",
        rootPrincipal: {
          kind: "trigger",
          triggerId: "t1",
          onBehalfOfUserId: "owner-1",
          name: "Owner",
        },
      },
      { id: "owner-1", name: "Sub-agent" },
      "headless",
    ],
  ] as const)(
    "resolves %s's turn for the right user and run mode",
    async (_label, principal, user, runMode) => {
      mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
      mockStreamText.mockReturnValueOnce(streamResultOf(fakeGenerateResult));

      await runner.generate({
        scope: { ...scope, principal },
        input: baseInput,
        sink: new RecordingSink(),
      });

      expect(mockPrepareChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({ user, runMode }),
      );
    },
  );

  // The sink's writes are its own business: a failed terminal or progress
  // write is logged, and the run's answer still reaches the caller.
  it("still returns the answer when the sink fails to record the run", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockImplementationOnce(
      ({ onStepFinish }: { onStepFinish: (s: unknown) => void }) => {
        onStepFinish({ toolCalls: [], usage: {} });
        return streamResultOf(fakeGenerateResult);
      },
    );
    const sink = new RecordingSink();
    sink.onProgress = () => Promise.reject(new Error("progress write failed"));
    sink.onFinish = () => Promise.reject(new Error("finish write failed"));

    const result = await runner.generate({ scope, input: baseInput, sink });

    expect(result.text).toBe("ok");
    const errors = vi.mocked(logger.error).mock.calls.map((c) => c[1]);
    expect(errors).toEqual(
      expect.arrayContaining(["Error in onProgress", "Error in onFinish"]),
    );
  });

  it("forwards the resolved plan from prepareChatTurn to onResolved", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockReturnValueOnce(streamResultOf(fakeGenerateResult));

    const sink = new RecordingSink();
    await runner.generate({ scope, input: baseInput, sink });

    const resolved = sink.events.find((e) => e.name === "onResolved");
    expect(resolved?.plan.resolved.agentId).toBe("agent-1");
    expect(resolved?.plan.resolved.providerId).toBe("p1");
  });

  // Unattended runs include a no-progress stop condition alongside the step
  // ceiling. A board re-read whose result is identical K times trips it.
  const repeatedReadSteps = () => {
    const board = { cards: [] };
    const read = {
      toolResults: [
        {
          type: "tool-result" as const,
          toolCallId: "r",
          toolName: "getBoardState",
          input: { boardId: "b1" },
          output: board,
        },
      ],
    };
    return [read, read, read];
  };

  it("enables no-progress detection and records a no_progress failure when it trips", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    let capturedStopWhen: unknown[] = [];
    mockStreamText.mockImplementation(
      ({ stopWhen }: { stopWhen: Array<(o: unknown) => unknown> }) => {
        capturedStopWhen = stopWhen;
        // The detector is the second condition (the first is the mocked
        // stepCountIs). Drive it as the SDK loop would, with repeated steps,
        // and settle the result only once it has been asked.
        return streamResultOf(fakeGenerateResult, {
          settleAfter: Promise.resolve(
            stopWhen[1]({ steps: repeatedReadSteps() }),
          ),
        });
      },
    );

    const sink = new RecordingSink();
    await runner.generate({
      scope,
      input: { ...baseInput, runId: "np-1" },
      sink,
    });

    // Two stop conditions for an unattended run: step ceiling + no-progress.
    expect(capturedStopWhen).toHaveLength(2);
    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("failed");
    expect(finish.error).toContain("no_progress");
    expect(finish.error).toContain("getBoardState");
  });

  it("does not abort when a repeated call's result changes (no trip)", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockImplementation(
      ({ stopWhen }: { stopWhen: Array<(o: unknown) => unknown> }) => {
        const mk = (cards: number) => ({
          toolResults: [
            {
              type: "tool-result" as const,
              toolCallId: "r",
              toolName: "getBoardState",
              input: { boardId: "b1" },
              output: { cards },
            },
          ],
        });
        return streamResultOf(fakeGenerateResult, {
          settleAfter: Promise.resolve(
            stopWhen[1]({ steps: [mk(0), mk(1), mk(2)] }),
          ),
        });
      },
    );

    const sink = new RecordingSink();
    await runner.generate({
      scope,
      input: { ...baseInput, runId: "np-2" },
      sink,
    });

    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("succeeded");
    expect(finish.error).toBeUndefined();
  });
});

describe("AgentRunner.stream — failure paths", () => {
  let runner: AgentRunner;
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
  });

  it("invariant: reaches onFinish when prepareChatTurn throws", async () => {
    mockPrepareChatTurn.mockRejectedValueOnce(new Error("Workspace missing"));

    const sink = new RecordingSink();
    await expect(
      runner.stream({
        scope,
        input: baseInput,
        sink,
        options: { origin: "http://test" },
      }),
    ).rejects.toThrow("Workspace missing");

    expect(sink.names()).toEqual(["onStart", "onFinish"]);
    const finish = sink.events[1] as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("failed");
    expect(finish.error).toBe("Workspace missing");
    // Stream was never invoked
    expect(mockStreamText).not.toHaveBeenCalled();
  });
});

// Issue #648. A Chat run's id IS the chat id, so a duplicate submission into a
// Chat with a live turn arrives with a runId the registry already holds. The
// ORDER is the whole point: the claim has to come before the sink's start hook,
// because that hook overwrites the row's messages with the second request's
// history. Claim second and the duplicate destroys the live run's persisted
// state on its way to failing.
describe("AgentRunner — duplicate submission for a live run", () => {
  let runner: AgentRunner;
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
    resetStreamHarness();
  });

  // These runs are deliberately left in flight, so the registry entries and the
  // unconsumed `once` mock values have to be cleared by hand — `clearAllMocks`
  // resets recorded calls but not a queued `mockResolvedValueOnce`.
  afterEach(() => {
    runRegistry.unregister("chat-live");
    runRegistry.unregister("chat-start-throws");
    mockPrepareChatTurn.mockReset();
    mockStreamText.mockReset();
  });

  const liveRun = async (sink: RecordingSink) => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    streamHarness.queue = new streamHarness.AsyncQueue();
    primeStreamText();
    await runner.stream({
      scope,
      input: {
        ...baseInput,
        runId: "chat-live",
        messages: [{ id: "u1", role: "user", parts: [] }] as never,
      },
      sink,
      options: { origin: "http://test" },
    });
  };

  it("rejects the duplicate with a ConflictError (409) and writes nothing", async () => {
    const sink = new RecordingSink();
    await liveRun(sink);

    // The second submission carries its own history — what would have replaced
    // the live run's messages.
    await expect(
      runner.stream({
        scope,
        input: {
          ...baseInput,
          runId: "chat-live",
          messages: [
            { id: "u1", role: "user", parts: [] },
            { id: "a1", role: "assistant", parts: [] },
            { id: "u2", role: "user", parts: [] },
          ] as never,
        },
        sink,
        options: { origin: "http://test" },
      }),
    ).rejects.toThrow(ConflictError);

    // One start hook, carrying the live run's own history — byte-for-byte what
    // it was registered with.
    const starts = sink.events.filter((e) => e.name === "onStart");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ messages: [{ id: "u1" }] });
    expect(mockValidateTurnAttachments).toHaveBeenCalledTimes(2);
  });

  it("leaves the live run running rather than terminating it", async () => {
    const sink = new RecordingSink();
    await liveRun(sink);

    await expect(
      runner.stream({
        scope,
        input: { ...baseInput, runId: "chat-live" },
        sink,
        options: { origin: "http://test" },
      }),
    ).rejects.toThrow(ConflictError);

    expect(sink.names()).not.toContain("onFinish");
    expect(runRegistry.has("chat-live")).toBe(true);
  });

  // The claim being first means a hook that throws would otherwise hold the id
  // forever — and since the id is the chat id, that locks the Chat out of every
  // later turn, not just this one.
  it("releases the claim when the start hook throws", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    const sink = new RecordingSink();
    sink.onStart = () => Promise.reject(new Error("row write failed"));

    await expect(
      runner.stream({
        scope,
        input: { ...baseInput, runId: "chat-start-throws" },
        sink,
        options: { origin: "http://test" },
      }),
    ).rejects.toThrow("row write failed");

    expect(runRegistry.has("chat-start-throws")).toBe(false);
    expect(mockStreamText).not.toHaveBeenCalled();
  });
});

describe("AgentRunner.cancel", () => {
  let runner: AgentRunner;
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
  });

  it("cancels an in-flight generate run with status=cancelled", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    // Make generateText hang until aborted
    mockStreamText.mockImplementation(hangingUntilAbort);

    const sink = new RecordingSink();
    const inFlight = runner.generate({
      scope,
      input: { ...baseInput, runId: "cancel-1" },
      sink,
    });

    // Wait a tick so the run registers
    await new Promise((r) => setTimeout(r, 0));

    expect(runner.cancel("cancel-1")).toBe(true);

    await expect(inFlight).rejects.toThrow();

    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.name).toBe("onFinish");
    expect(finish.status).toBe("cancelled");
  });

  // AC 2 of #523 rests on this: a closer a Contribution registered runs on a
  // cancelled turn because the run's teardown disposes the session, and it runs
  // *once* because dispose is idempotent. That a session's dispose then closes
  // each registered closer exactly once is pinned in `tool-session.test.ts`;
  // what this pins is the half only the run knows — that cancellation reaches
  // dispose at all, and reaches it before the terminal write.
  it("disposes the turn exactly once when a run is cancelled, before onFinish", async () => {
    const sink = new RecordingSink();
    // What the sink had recorded at the moment teardown ran. Teardown must
    // precede the terminal write, or a closer's work outlives the run's status.
    const seenAtDispose: string[][] = [];
    const dispose = vi.fn().mockImplementation(() => {
      seenAtDispose.push(sink.names());
      return Promise.resolve();
    });
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn({ dispose }));
    mockStreamText.mockImplementation(hangingUntilAbort);

    const inFlight = runner.generate({
      scope,
      input: { ...baseInput, runId: "cancel-dispose" },
      sink,
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(runner.cancel("cancel-dispose")).toBe(true);
    await expect(inFlight).rejects.toThrow();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(seenAtDispose).toHaveLength(1);
    expect(seenAtDispose[0]).not.toContain("onFinish");

    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("cancelled");
  });

  it("cancel(unknown) returns false", () => {
    expect(runner.cancel("never-existed")).toBe(false);
  });

  it("per-run timeout produces onFinish with status=failed and TimeoutError", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockImplementation(hangingUntilAbort);

    const sink = new RecordingSink();
    const inFlight = runner.generate({
      scope,
      input: { ...baseInput, runId: "timeout-1" },
      sink,
      options: {
        timeouts: { perRunTimeoutMs: 5, perStepTimeoutMs: 1_000_000 },
      },
    });

    await expect(inFlight).rejects.toThrow();

    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("failed");
    expect(finish.error).toMatch(/per-run timeout/);
  });

  it("unregisters the run after generate succeeds", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockReturnValueOnce(streamResultOf(fakeGenerateResult));

    const sink = new RecordingSink();
    await runner.generate({
      scope,
      input: { ...baseInput, runId: "ok-1" },
      sink,
    });

    expect(runner.cancel("ok-1")).toBe(false);
    expect(runRegistry.has("ok-1")).toBe(false);
  });
});

const tick = () => new Promise((r) => setTimeout(r, 0));

const resetStreamHarness = (): void => {
  streamHarness.queue = null;
  streamHarness.onStepFinish = undefined;
  streamHarness.onFinish = undefined;
  streamHarness.onToolExecutionEnd = undefined;
  streamHarness.messageMetadata = undefined;
};

/**
 * A stand-in for what `toUIMessageStream` returns.
 *
 * A real (empty) `ReadableStream` rather than a `{ tee }` literal, because the
 * runner pipes it through the tool-duration transform before teeing — a literal
 * with only the methods used today silently becomes a lie the moment the
 * pipeline changes. Nothing reads the branches: `readUIMessageStream` is mocked
 * to the harness queue and the response is a sentinel.
 */
const emptyUIStream = () =>
  new ReadableStream({
    start: (controller) => controller.close(),
  });

// Make streamText return a fake result whose UI-stream callbacks the test can
// drive by hand: `onStepFinish` (per step), `onFinish` (completion), and
// `messageMetadata` (per stream part).
const primeStreamText = () => {
  mockStreamText.mockImplementation(
    (opts: {
      onStepFinish?: (step: unknown) => void;
      onToolExecutionEnd?: (ctx: {
        toolCall: { toolCallId: string };
        toolExecutionMs: number;
      }) => void;
    }) => {
      streamHarness.onStepFinish = opts.onStepFinish;
      streamHarness.onToolExecutionEnd = opts.onToolExecutionEnd;
      return {
        toUIMessageStream: (uiOpts: {
          onFinish: (ctx: { messages: unknown[] }) => Promise<void> | void;
          messageMetadata: (opts: { part: MetadataPart }) => unknown;
        }) => {
          streamHarness.onFinish = uiOpts.onFinish;
          streamHarness.messageMetadata = uiOpts.messageMetadata;
          return emptyUIStream();
        },
      };
    },
  );
};

// Issue #630, Path B. Both run timers are armed when the run is registered,
// which happens BEFORE Turn resolution is awaited — so a resolution slower
// than the per-step bound terminates the run while it is still in flight.
// The turn then arrives at a run that can no longer dispose it: the session,
// its MCP clients and every closer a Contribution registered stayed open for
// the life of the process, and the run — already recorded as failed — went
// on to spend a provider call the caller was handed as a success.
describe("a turn that resolves after its run has already terminated", () => {
  let runner: AgentRunner;
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Resolves a turn well after the 5ms per-step bound below has fired. */
  const slowPrepare = (dispose: () => Promise<void>) =>
    mockPrepareChatTurn.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return fakeTurn({ dispose });
    });

  /** Starts the run and lets the per-step bound fire before the turn lands. */
  const timedOutRun = async (sink: RunSink, dispose: () => Promise<void>) => {
    slowPrepare(dispose);
    const inFlight = runner.generate({
      scope,
      input: { ...baseInput, runId: "late-prepare" },
      sink,
      options: {
        timeouts: { perStepTimeoutMs: 5, perRunTimeoutMs: 1_000_000 },
      },
    });
    // Observed by the caller's own assertion; this only keeps the rejection
    // from surfacing as unhandled while the clock is advanced.
    inFlight.catch(() => {});
    await vi.advanceTimersByTimeAsync(60);
    return inFlight;
  };

  it("disposes it, since the run's own teardown has already been and gone", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);

    await expect(timedOutRun(new RecordingSink(), dispose)).rejects.toThrow(
      TimeoutError,
    );

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  // Against a REAL session, not a stub `dispose`: what leaks on this path is
  // whatever the session holds, and a Contribution's closers are the half that
  // a fake turn cannot speak for. `registerCloser` is the seam `ctx.registerCloser`
  // reaches, so this is the Plugin-facing promise — "core runs your closer once,
  // when the turn ends" — asserted on the path that used to break it.
  it("runs a closer a Contribution registered, exactly once", async () => {
    const session = await openToolSession(
      {
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
        frontendUrl: undefined,
      },
      undefined,
      { getMcp: () => Promise.resolve(null) },
    );
    const close = vi.fn().mockResolvedValue(undefined);
    session.registerCloser(close);

    await expect(
      timedOutRun(new RecordingSink(), session.dispose),
    ).rejects.toThrow(TimeoutError);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not invoke the model", async () => {
    mockStreamText.mockReturnValue(streamResultOf(fakeGenerateResult));
    const sink = new RecordingSink();

    await expect(
      timedOutRun(sink, vi.fn().mockResolvedValue(undefined)),
    ).rejects.toThrow(TimeoutError);

    expect(mockStreamText).not.toHaveBeenCalled();
    // The run was told it failed and nothing walked that back — no second
    // terminal write, and no `onResolved` for a plan that never ran.
    expect(sink.names()).toEqual(["onStart", "onFinish"]);
    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("failed");
    expect(finish.error).toMatch(/per-step timeout/);
    expect(runRegistry.has("late-prepare")).toBe(false);
  });

  // The caller has to be able to tell. Before the fix `generate` returned the
  // model's text as though nothing had happened.
  it("fails the caller with the error the run terminated on", async () => {
    const inFlight = timedOutRun(
      new RecordingSink(),
      vi.fn().mockResolvedValue(undefined),
    );

    await expect(inFlight).rejects.toMatchObject({
      name: "TimeoutError",
      kind: "step",
    });
  });

  // A user pressing stop while the turn is still resolving: a cancellation
  // carries no error of its own, so the caller is still told the run never
  // started rather than being handed the model's answer.
  it("fails the caller when the run was cancelled while the turn resolved", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    slowPrepare(dispose);
    const sink = new RecordingSink();
    const inFlight = runner.generate({
      scope,
      input: { ...baseInput, runId: "cancel-prepare" },
      sink,
    });
    inFlight.catch(() => {});

    await vi.advanceTimersByTimeAsync(10);
    expect(runner.cancel("cancel-prepare")).toBe(true);
    await vi.advanceTimersByTimeAsync(60);

    await expect(inFlight).rejects.toThrow(
      "Run 'cancel-prepare' ended before it could start",
    );
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(mockStreamText).not.toHaveBeenCalled();
    expect(sink.names()).toEqual(["onStart", "onFinish"]);
    expect(
      (sink.events[1] as Extract<LifecycleEvent, { name: "onFinish" }>).status,
    ).toBe("cancelled");
  });
});

describe("AgentRunner.stream — success & interruption", () => {
  let runner: AgentRunner;
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
    resetStreamHarness();
  });

  it("runs the full lifecycle on success and persists the final messages", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn({ dispose }));
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;
    primeStreamText();

    const sink = new RecordingSink();
    const res = await runner.stream({
      scope,
      input: { ...baseInput, runId: "s-ok" },
      sink,
      options: { origin: "http://test" },
    });
    expect(res).toBe(streamHarness.responseSentinel);

    // A step completes -> onProgress.
    streamHarness.onStepFinish!({
      usage: { inputTokens: 3, outputTokens: 4 },
      toolCalls: [],
    });
    // A partial snapshot streams in over the server-side branch.
    queue.push({ id: "m1", role: "assistant", parts: [] });
    await tick();
    // Natural completion delivers the final assistant message.
    const finalMessages = [
      { id: "m1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ];
    await streamHarness.onFinish!({ messages: finalMessages });
    queue.end();
    await tick();

    expect(sink.names()).toEqual([
      "onStart",
      "onResolved",
      "onProgress",
      "onFinish",
    ]);
    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("succeeded");
    expect(finish.error).toBeUndefined();
    expect(finish.messages).toEqual(finalMessages);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(runRegistry.has("s-ok")).toBe(false);
  });

  // A user-invoked Skill arrives as a trailing assistant message carrying the
  // seeded `loadSkill` pair (issue #649). The SDK folds the reply into that
  // same message and reuses its id, so a mid-run flush must REPLACE it — the
  // append this path used to do wrote two assistant messages under one id, and
  // a user reconnecting mid-run saw the card twice.
  it("replaces a trailing assistant message the stream continues rather than appending beside it", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;
    primeStreamText();

    const seeded = {
      id: "msg-seed",
      role: "assistant",
      parts: [
        {
          type: "tool-loadSkill",
          toolCallId: "call-1",
          state: "output-available",
          input: { name: "blog-post" },
          output: { name: "blog-post", body: "Write a blog post." },
        },
      ],
    };
    const user = { id: "u1", role: "user", parts: [] };

    const sink = new RecordingSink();
    const progressMessages: unknown[][] = [];
    sink.onProgress = (ctx: { runId: string; messages: unknown[] }) => {
      progressMessages.push(ctx.messages);
      return Promise.resolve();
    };

    await runner.stream({
      scope,
      input: {
        ...baseInput,
        runId: "s-continuation",
        messages: [user, seeded] as RunInput["messages"],
      },
      sink,
      options: { origin: "http://test" },
    });

    // The SDK's continuation: the streamed message carries the seeded id, with
    // the reply folded in beside the tool parts.
    const continued = {
      id: "msg-seed",
      role: "assistant",
      parts: [...seeded.parts, { type: "text", text: "Here you go." }],
    };
    queue.push(continued);
    await tick();
    streamHarness.onStepFinish!({ usage: {}, toolCalls: [] });
    await tick();

    expect(progressMessages.at(-1)).toEqual([user, continued]);

    await streamHarness.onFinish!({ messages: [user, continued] });
    queue.end();
    await tick();
  });

  it("still appends a snapshot that opened a message of its own", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;
    primeStreamText();

    const user = { id: "u1", role: "user", parts: [] };
    const sink = new RecordingSink();
    const progressMessages: unknown[][] = [];
    sink.onProgress = (ctx: { runId: string; messages: unknown[] }) => {
      progressMessages.push(ctx.messages);
      return Promise.resolve();
    };

    await runner.stream({
      scope,
      input: {
        ...baseInput,
        runId: "s-fresh",
        messages: [user] as RunInput["messages"],
      },
      sink,
      options: { origin: "http://test" },
    });

    const fresh = { id: "m1", role: "assistant", parts: [] };
    queue.push(fresh);
    await tick();
    streamHarness.onStepFinish!({ usage: {}, toolCalls: [] });
    await tick();

    expect(progressMessages.at(-1)).toEqual([user, fresh]);

    await streamHarness.onFinish!({ messages: [user, fresh] });
    queue.end();
    await tick();
  });

  it("persists each tool call's execution time on the finished messages", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;
    primeStreamText();

    const sink = new RecordingSink();
    await runner.stream({
      scope,
      input: { ...baseInput, runId: "s-durations" },
      sink,
      options: { origin: "http://test" },
    });

    streamHarness.onToolExecutionEnd!({
      toolCall: { toolCallId: "call-1" },
      toolExecutionMs: 1234,
    });
    await streamHarness.onFinish!({
      messages: [
        {
          id: "m1",
          role: "assistant",
          parts: [
            {
              type: "tool-getCard",
              toolCallId: "call-1",
              state: "output-available",
              input: {},
              output: {},
            },
          ],
        },
      ],
    });
    queue.end();
    await tick();

    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    const message = finish.messages![0] as { parts: unknown[] };
    expect(message.parts[0]).toMatchObject({
      toolMetadata: { durationMs: 1234 },
    });
  });

  // The two branches of the teed UI stream race: `onFinish` fires on the source
  // while the server-side snapshot branch may still have buffered chunks, and
  // disposing the turn is real I/O that gives that branch time to drain. A
  // snapshot landing in that window used to overwrite the finished messages —
  // silently costing them their durations, since a snapshot carries none.
  it("keeps the final messages when a snapshot lands during teardown", async () => {
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;
    const dispose = vi.fn().mockImplementation(async () => {
      queue.push({
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-getCard",
            toolCallId: "call-1",
            state: "output-available",
            input: {},
            output: {},
          },
        ],
      });
      await tick();
    });
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn({ dispose }));
    primeStreamText();

    const sink = new RecordingSink();
    await runner.stream({
      scope,
      input: { ...baseInput, runId: "s-late-snapshot" },
      sink,
      options: { origin: "http://test" },
    });

    streamHarness.onToolExecutionEnd!({
      toolCall: { toolCallId: "call-1" },
      toolExecutionMs: 1234,
    });
    await streamHarness.onFinish!({
      messages: [
        {
          id: "m1",
          role: "assistant",
          parts: [
            {
              type: "tool-getCard",
              toolCallId: "call-1",
              state: "output-available",
              input: {},
              output: {},
            },
          ],
        },
      ],
    });
    queue.end();
    // The run is finished by the drive once the background snapshot branch
    // drains (and teardown disposes the turn, pushing the racing snapshot).
    // Await that drain deterministically before reading the terminal sink write.
    await vi.waitFor(
      () => expect(runRegistry.has("s-late-snapshot")).toBe(false),
      { timeout: 2_000 },
    );

    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    const message = finish.messages![0] as { parts: unknown[] };
    expect(message.parts[0]).toMatchObject({
      toolMetadata: { durationMs: 1234 },
    });
  });

  it("interactive stream runs are NOT subject to no-progress detection", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;
    let capturedStopWhen: unknown[] = [];
    mockStreamText.mockImplementation(
      (opts: {
        stopWhen: unknown[];
        onStepFinish: (step: unknown) => void;
      }) => {
        capturedStopWhen = opts.stopWhen;
        streamHarness.onStepFinish = opts.onStepFinish;
        return {
          toUIMessageStream: (uiOpts: {
            onFinish: (ctx: { messages: unknown[] }) => Promise<void> | void;
          }) => {
            streamHarness.onFinish = uiOpts.onFinish;
            return emptyUIStream();
          },
        };
      },
    );

    const sink = new RecordingSink();
    await runner.stream({
      scope,
      input: { ...baseInput, runId: "s-no-detector" },
      sink,
      options: { origin: "http://test" },
    });

    // Only the step ceiling — no no-progress condition for interactive runs.
    expect(capturedStopWhen).toHaveLength(1);

    await streamHarness.onFinish!({ messages: [] });
    queue.end();
    await tick();
  });

  it("finalises as cancelled with the partial messages when cancelled mid-stream", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;
    primeStreamText();

    const sink = new RecordingSink();
    await runner.stream({
      scope,
      input: { ...baseInput, runId: "s-cancel" },
      sink,
      options: { origin: "http://test" },
    });

    const partial = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "par" }],
    };
    queue.push(partial);
    await tick();

    expect(runner.cancel("s-cancel")).toBe(true);
    // The SDK observes the abort and finishes the UI stream.
    await streamHarness.onFinish!({ messages: [partial] });
    queue.end();
    await tick();

    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("cancelled");
    expect(finish.messages).toEqual([partial]);
  });

  it("finalises as failed with a TimeoutError and the partial messages on per-run timeout", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;
    primeStreamText();

    const sink = new RecordingSink();
    await runner.stream({
      scope,
      input: { ...baseInput, runId: "s-timeout" },
      sink,
      options: {
        origin: "http://test",
        timeouts: { perRunTimeoutMs: 5, perStepTimeoutMs: 1_000_000 },
      },
    });

    const partial = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "par" }],
    };
    queue.push(partial);
    await tick();
    // Let the per-run timer fire -> registry aborts -> onTimeout -> finalize.
    await vi.waitFor(() => expect(sink.names()).toContain("onFinish"));
    queue.end();
    await tick();

    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("failed");
    expect(finish.error).toMatch(/per-run timeout/);
    // The snapshot accumulated before the timeout is what gets persisted.
    expect(finish.messages).toEqual([partial]);
    expect(runRegistry.has("s-timeout")).toBe(false);
  });
});

// The metadata callback is the only seam for saying anything about a stream
// that has already been flushed to the client — issue #420's truncation flag
// and issue #448's Context occupancy both ride on it.
describe("AgentRunner.stream — message metadata", () => {
  let runner: AgentRunner;
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
    resetStreamHarness();
  });

  const startStream = async (turn: ReturnType<typeof fakeTurn>) => {
    mockPrepareChatTurn.mockResolvedValueOnce(turn);
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;
    primeStreamText();

    await runner.stream({
      scope,
      input: { ...baseInput, runId: `s-meta-${Math.random()}` },
      sink: new RecordingSink(),
      options: { origin: "http://test" },
    });

    return {
      metadataFor: (part: MetadataPart) =>
        streamHarness.messageMetadata!({ part }),
      end: async () => {
        await streamHarness.onFinish!({ messages: [] });
        queue.end();
        await tick();
      },
    };
  };

  it("attributes the message to the resolved agent at the start of the stream", async () => {
    const stream = await startStream(fakeTurn());

    // `prepDurationMs` rides the same `start` part (issue #354) — real
    // elapsed time from `setup()`, so only its presence and type are pinned
    // here.
    expect(stream.metadataFor({ type: "start" })).toEqual({
      agentId: "agent-1",
      prepDurationMs: expect.any(Number) as unknown,
    });

    await stream.end();
  });

  // A direct provider/model chat resolves no agent, so its start carries no
  // agent attribution — which is exactly the case that had no way to be
  // flagged while `agentId` was a required field. `prepDurationMs` still
  // rides `start` regardless, since it is a Turn resolution fact.
  it("still flags a truncated direct provider/model stream that has no attribution", async () => {
    const turn = fakeTurn();
    turn.resolved = {
      ...turn.resolved,
      agentId: undefined as unknown as string,
    };
    const stream = await startStream(turn);

    // `prepDurationMs` is present even with no agent to attribute — it is a
    // Turn resolution fact, not an agent one.
    expect(stream.metadataFor({ type: "start" })).toEqual({
      prepDurationMs: expect.any(Number) as unknown,
    });
    expect(
      stream.metadataFor({ type: "finish", finishReason: "length" }),
    ).toEqual({ truncatedByTokenLimit: true });

    await stream.end();
  });

  // Issue #522: the flag is decided during Turn resolution and reaches the
  // stream on the same path the attribution takes — the runner forwards what
  // `prepareChatTurn` returned, and nothing re-derives it here.
  it("carries the search-unavailable flag from the prepared turn to the stream", async () => {
    const turn = { ...fakeTurn(), searchUnavailable: true };
    const stream = await startStream(turn);

    expect(stream.metadataFor({ type: "start" })).toEqual({
      agentId: "agent-1",
      searchUnavailable: true,
      prepDurationMs: expect.any(Number) as unknown,
    });

    await stream.end();
  });

  // A step inside a tool loop can end at the ceiling and the run still recover
  // and finish normally. Marking those flags runs that were never truncated.
  it("ignores a step that ended at the limit mid tool-loop", async () => {
    const stream = await startStream(fakeTurn());

    expect(
      stream.metadataFor({
        type: "finish-step",
        finishReason: "length",
        usage: { inputTokens: 100, outputTokens: 20 },
      }),
    ).not.toHaveProperty("truncatedByTokenLimit");

    await stream.end();
  });

  // Issue #448. Occupancy rides on the step-finish part, not the terminal
  // finish: a cancelled turn never gets a terminal finish, and cancelling a
  // long turn is exactly when the context had grown most.
  it("records the model call's token counts on a finished step", async () => {
    const stream = await startStream(fakeTurn());

    expect(
      stream.metadataFor({
        type: "finish-step",
        finishReason: "stop",
        usage: { inputTokens: 12_400, outputTokens: 180 },
      }),
    ).toEqual({
      contextOccupancy: { inputTokens: 12_400, outputTokens: 180 },
      // Token usage (issue #354) and the Model duration ride the same part.
      // On a single-step turn the sum equals this step's own reading.
      tokenUsage: { inputTokens: 12_400, outputTokens: 180 },
      modelDurationMs: expect.any(Number) as unknown,
    });

    await stream.end();
  });
});

// Issue #454: the ceiling the Provider declares for the model has to reach the
// generation call itself. Amazon Bedrock omits `inferenceConfig.maxTokens`
// entirely when the SDK is passed nothing, so a value stopping short of the
// call is a value that changes nothing.
describe("model output ceiling", () => {
  let runner: AgentRunner;
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
    resetStreamHarness();
  });

  const turnWithCeiling = (maxOutputTokens?: number) => {
    const turn = fakeTurn();
    return { ...turn, stream: { ...turn.stream, maxOutputTokens } };
  };

  it("passes the declared ceiling to the unattended streaming call", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(turnWithCeiling(64000));
    mockStreamText.mockReturnValueOnce(streamResultOf(fakeGenerateResult));

    await runner.generate({
      scope,
      input: baseInput,
      sink: new RecordingSink(),
    });

    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 64000 }),
    );
  });

  it("passes the declared ceiling to the streaming call", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(turnWithCeiling(32000));
    streamHarness.queue = new streamHarness.AsyncQueue();
    primeStreamText();

    await runner.stream({
      scope,
      input: { ...baseInput, runId: "s-ceiling" },
      sink: new RecordingSink(),
      options: { origin: "http://test" },
    });

    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 32000 }),
    );
  });

  // Undeclared has to stay undeclared: the SDK reads an absent key and an
  // `undefined` value the same way, and anything else would move the ceiling
  // for every Provider that has never set one.
  it("sends no ceiling when the model declares none", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(turnWithCeiling(undefined));
    mockStreamText.mockReturnValueOnce(streamResultOf(fakeGenerateResult));

    await runner.generate({
      scope,
      input: baseInput,
      sink: new RecordingSink(),
    });

    const args = mockStreamText.mock.calls[0][0] as {
      maxOutputTokens?: number;
    };
    expect(args.maxOutputTokens).toBeUndefined();
  });
});

/**
 * A turn cancelled while a tool was still running persists the tool call with
 * no result beside it. Sent as-is, a provider rejects the whole request
 * ("Tool result is missing for tool call ..."), so the next message in that
 * Chat — and every one after it — fails until the Chat is deleted.
 */
describe("dangling tool calls in the Transcript", () => {
  const danglingTranscript = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "run it" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "Running the command." },
        {
          type: "tool-shellExec",
          toolCallId: "call-1",
          state: "input-available",
          input: { command: "sleep 60" },
        },
      ],
    },
  ];

  it("converts the Transcript with incomplete tool calls ignored", async () => {
    mockPrepareChatTurn.mockReset();
    mockStreamText.mockReset();
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockReturnValueOnce(streamResultOf(fakeGenerateResult));

    await new AgentRunner().generate({
      scope,
      input: baseInput,
      sink: new RecordingSink(),
    });

    expect(vi.mocked(convertToModelMessages)).toHaveBeenCalledWith(
      expect.anything(),
      { ignoreIncompleteToolCalls: true },
    );
  });

  // What that flag buys, against the real SDK — the behaviour the line above
  // is only worth having if it keeps. A version that stopped dropping the
  // unanswered call would put the 400 back without touching our code.
  it("drops the unanswered call and keeps the text beside it", async () => {
    const { convertToModelMessages: convert } =
      await vi.importActual<typeof import("ai")>("ai");

    const converted = await convert(danglingTranscript as never, {
      ignoreIncompleteToolCalls: true,
    });

    expect(converted).toEqual([
      { role: "user", content: [{ type: "text", text: "run it" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Running the command." }],
      },
    ]);
  });
});
