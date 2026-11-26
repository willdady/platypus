import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

type MetadataPart = {
  type: string;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
};

const {
  mockPrepareChatTurn,
  mockValidateTurnAttachments,
  mockStreamText,
  mockToUIMessageStream,
  streamHarness,
} = vi.hoisted(() => {
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
    mockToUIMessageStream: vi.fn((_uiOpts: never) => {
      const uiOpts = _uiOpts as {
        messageMetadata?: (opts: {
          part: { type: "finish"; finishReason: string };
        }) => unknown;
      };
      const finishReason = streamHarness.terminalFinishReason;
      if (finishReason !== undefined) {
        uiOpts.messageMetadata?.({ part: { type: "finish", finishReason } });
      }
      return new ReadableStream({
        start: (controller) => controller.close(),
      });
    }),
    streamHarness: {
      AsyncQueue,
      queue: null as InstanceType<typeof AsyncQueue> | null,
      onStepEnd: undefined as ((step: unknown) => void) | undefined,
      onFinish: undefined as
        ((ctx: { messages: unknown[] }) => Promise<void> | void) | undefined,
      onToolExecutionEnd: undefined as
        | ((ctx: {
            toolCall: { toolCallId: string };
            toolExecutionMs: number;
          }) => void)
        | undefined,
      messageMetadata: undefined as
        ((opts: { part: MetadataPart }) => unknown) | undefined,
      terminalFinishReason: undefined as string | undefined,
      responseSentinel: { __isResponse: true },
    },
  };
});

vi.mock("../services/chat-execution.ts", () => ({
  drizzleChatTurnQueries: {},
  prepareChatTurn: mockPrepareChatTurn,
  validateTurnAttachments: mockValidateTurnAttachments,
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    streamText: (...args: unknown[]) => {
      const result = mockStreamText(...args) as
        { stream?: unknown } | undefined;
      if (result && result.stream === undefined) {
        result.stream = new ReadableStream();
      }
      return result;
    },
    toUIMessageStream: mockToUIMessageStream,
    convertToModelMessages: vi.fn().mockReturnValue([]),
    createIdGenerator: vi.fn().mockReturnValue(() => "msg-1"),
    stepCountIs: vi.fn(),
    readUIMessageStream: () => streamHarness.queue,
    createUIMessageStreamResponse: () => streamHarness.responseSentinel,
  };
});

import { convertToModelMessages } from "ai";
import { convertDataPart } from "../sandbox/upload-note.ts";
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
  includeMemories: true,
  memoryTools: true,
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
  usage: { inputTokens: 10, outputTokens: 5 },
};

const streamResultOf = (
  data: {
    text?: string;
    steps?: unknown[];
    usage: unknown;
    finishReason?: string;
    rawFinishReason?: string;
  },
  opts: { settleAfter?: Promise<unknown> } = {},
) => {
  const gate = opts.settleAfter ?? Promise.resolve();
  const after = <T>(value: T) => gate.then(() => value);
  streamHarness.terminalFinishReason = data.finishReason ?? "stop";
  return {
    text: after(data.text ?? "ok"),
    steps: after(data.steps ?? []),
    usage: after(data.usage),
    finishReason: after(data.finishReason ?? "stop"),
    rawFinishReason: after(data.rawFinishReason ?? "stop"),
  };
};

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

  it.each([
    ["tool-calls", "tool_use"],
    ["other", "malformed_tool_use"],
  ])(
    "logs the unified (%s) and the raw (%s) finish reason for a step",
    async (finishReason, rawFinishReason) => {
      mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
      mockStreamText.mockImplementationOnce(
        (args: { onStepEnd: (s: unknown) => void }) => {
          args.onStepEnd({
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
        options: { frontendUrl: "http://localhost:3000" },
      });

      expect(stepLogs()[0]).toMatchObject({ finishReason, rawFinishReason });
    },
  );

  it("warns when a step stops at the output token limit", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockImplementationOnce(
      (args: { onStepEnd: (s: unknown) => void }) => {
        args.onStepEnd({
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
      options: { frontendUrl: "http://localhost:3000" },
    });

    const warned = vi
      .mocked(logger.warn)
      .mock.calls.some((call) => /truncated/i.test(String(call[1])));
    expect(warned).toBe(true);
  });

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

    const result = await runner.generate({
      scope,
      input: baseInput,
      sink,
      options: { frontendUrl: "http://localhost:3000" },
    });

    expect(sink.finalStats()?.truncatedByTokenLimit).toBe(true);
    expect(result.stats.truncatedByTokenLimit).toBe(true);
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

    const result = await runner.generate({
      scope,
      input: baseInput,
      sink,
      options: { frontendUrl: "http://localhost:3000" },
    });

    expect(sink.finalStats()).not.toHaveProperty("truncatedByTokenLimit");
    expect(result.text).toBe("ok");
  });

  it("hands the sink the unattended run's reply after its user message", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockReturnValueOnce(streamResultOf(fakeGenerateResult));
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;
    const reply = {
      id: "msg-1",
      role: "assistant",
      parts: [{ type: "text", text: "ok" }],
    };
    queue.push(reply);
    queue.end();
    const user = {
      id: "u1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Do something" }],
    };
    const sink = new RecordingSink();

    await runner.generate({
      scope,
      input: { ...baseInput, messages: [user] },
      sink,
      options: { frontendUrl: "http://localhost:3000" },
    });

    const finish = sink.events.find((e) => e.name === "onFinish");
    expect(finish?.messages).toEqual([user, reply]);
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
      options: { frontendUrl: "http://localhost:3000" },
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

describe("rejected tool input instrumentation", () => {
  let runner: AgentRunner;
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
    streamHarness.queue = null;
    streamHarness.onStepEnd = undefined;
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
      (args: { onStepEnd: (s: unknown) => void }) => {
        args.onStepEnd(stepWith(content));
        return streamResultOf(fakeGenerateResult);
      },
    );
    await runner.generate({
      scope,
      input: baseInput,
      sink: new RecordingSink(),
      options: { frontendUrl: "http://localhost:3000" },
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
      (opts: { onStepEnd: (step: unknown) => void }) => {
        streamHarness.onStepEnd = opts.onStepEnd;
        return {};
      },
    );

    await runner.stream({
      scope,
      input: { ...baseInput, runId: "s-rejected" },
      sink: new RecordingSink(),
      options: { origin: "http://test", frontendUrl: "http://localhost:3000" },
    });
    streamHarness.onStepEnd!(
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

  it("hands the sink a Run event recorder for this run at start", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockReturnValueOnce(streamResultOf(fakeGenerateResult));

    const sink = new RecordingSink();
    await runner.generate({
      scope,
      input: { ...baseInput, runId: "events-1" },
      sink,
      options: { frontendUrl: "http://localhost:3000" },
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
    await runner.generate({
      scope,
      input: baseInput,
      sink,
      options: { frontendUrl: "http://localhost:3000" },
    });

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
    const result = await runner.generate({
      scope,
      input: baseInput,
      sink,
      options: { frontendUrl: "http://localhost:3000" },
    });

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

  it("records Context occupancy from the final step, not the sum across steps", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    const steps = [
      { toolCalls: [], usage: { inputTokens: 1_000, outputTokens: 40 } },
      { toolCalls: [], usage: { inputTokens: 3_500, outputTokens: 60 } },
    ];
    mockStreamText.mockImplementationOnce(
      ({ onStepEnd }: { onStepEnd: (s: unknown) => void }) => {
        steps.forEach(onStepEnd);
        return streamResultOf({
          text: "ok",
          steps,
          usage: { inputTokens: 4_500, outputTokens: 100 },
        });
      },
    );

    const sink = new RecordingSink();
    const result = await runner.generate({
      scope,
      input: baseInput,
      sink,
      options: { frontendUrl: "http://localhost:3000" },
    });

    expect(result.stats.contextOccupancy).toBe(3_500);
    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.stats?.contextOccupancy).toBe(3_500);
    expect(finish.stats?.inputTokens).toBe(4_500);
    expect(finish.stats?.outputTokens).toBe(100);
  });

  it("clears the interim occupancy when a step reports no usage", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    const progressed: Array<number | undefined> = [];
    mockStreamText.mockImplementationOnce(
      ({ onStepEnd }: { onStepEnd: (s: unknown) => void }) => {
        onStepEnd({
          toolCalls: [],
          usage: { inputTokens: 1_000, outputTokens: 40 },
        });
        onStepEnd({ toolCalls: [] });
        return streamResultOf({
          text: "ok",
          steps: [{ toolCalls: [] }],
          usage: {},
        });
      },
    );

    const sink = new RecordingSink();
    const recorded = sink.onProgress.bind(sink);
    // why: the runner reuses one mutated stats object, so copy the figure per flush
    sink.onProgress = (ctx: { runId: string; stats?: RunStats }) => {
      progressed.push(ctx.stats?.contextOccupancy);
      return recorded(ctx);
    };
    await runner.generate({
      scope,
      input: baseInput,
      sink,
      options: { frontendUrl: "http://localhost:3000" },
    });

    expect(progressed).toEqual([1_000, undefined]);
  });

  it("records no occupancy when the Provider reports no usage", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockReturnValueOnce(
      streamResultOf({
        text: "ok",
        steps: [{ toolCalls: [] }],
        usage: {},
      }),
    );

    const sink = new RecordingSink();
    const result = await runner.generate({
      scope,
      input: baseInput,
      sink,
      options: { frontendUrl: "http://localhost:3000" },
    });

    expect(result.stats.contextOccupancy).toBeUndefined();
  });

  it("invariant: reaches onFinish even when prepareChatTurn throws", async () => {
    mockPrepareChatTurn.mockRejectedValueOnce(new Error("Agent not found"));

    const sink = new RecordingSink();
    await expect(
      runner.generate({
        scope,
        input: baseInput,
        sink,
        options: { frontendUrl: "http://localhost:3000" },
      }),
    ).rejects.toThrow("Agent not found");

    expect(sink.names()).toEqual(["onStart", "onFinish"]);
    const finish = sink.events[1] as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("failed");
    expect(finish.error).toBe("Agent not found");
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
      runner.generate({
        scope,
        input: baseInput,
        sink,
        options: { frontendUrl: "http://localhost:3000" },
      }),
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
        options: { frontendUrl: "http://localhost:3000" },
      });

      expect(mockPrepareChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          user,
          runMode,
          sessionId: baseInput.runId,
        }),
        expect.anything(),
      );
    },
  );

  it("still returns the answer when the sink fails to record the run", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockImplementationOnce(
      ({ onStepEnd }: { onStepEnd: (s: unknown) => void }) => {
        onStepEnd({ toolCalls: [], usage: {} });
        return streamResultOf(fakeGenerateResult);
      },
    );
    const sink = new RecordingSink();
    sink.onProgress = () => Promise.reject(new Error("progress write failed"));
    sink.onFinish = () => Promise.reject(new Error("finish write failed"));

    const result = await runner.generate({
      scope,
      input: baseInput,
      sink,
      options: { frontendUrl: "http://localhost:3000" },
    });

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
    await runner.generate({
      scope,
      input: baseInput,
      sink,
      options: { frontendUrl: "http://localhost:3000" },
    });

    const resolved = sink.events.find((e) => e.name === "onResolved");
    expect(resolved?.plan.resolved.agentId).toBe("agent-1");
    expect(resolved?.plan.resolved.providerId).toBe("p1");
  });

  it("forwards the Tool sets that loaded no tools to onResolved (#1184)", async () => {
    const unloadedToolSets = [
      { toolSetId: "mcp-1", name: "Jira", reason: "unreachable" as const },
    ];
    mockPrepareChatTurn.mockResolvedValueOnce({
      ...fakeTurn(),
      unloadedToolSets,
    });
    mockStreamText.mockReturnValueOnce(streamResultOf(fakeGenerateResult));

    const sink = new RecordingSink();
    await runner.generate({
      scope,
      input: baseInput,
      sink,
      options: { frontendUrl: "http://localhost:3000" },
    });

    const resolved = sink.events.find((e) => e.name === "onResolved");
    expect(resolved?.plan.unloadedToolSets).toEqual(unloadedToolSets);
  });

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
      options: { frontendUrl: "http://localhost:3000" },
    });

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
      options: { frontendUrl: "http://localhost:3000" },
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

  it("rejects a turn's attachments before the sink writes anything", async () => {
    mockValidateTurnAttachments.mockRejectedValueOnce(
      new Error("unsupported file"),
    );

    const sink = new RecordingSink();
    await expect(
      runner.stream({
        scope,
        input: { ...baseInput, runId: "s-bad-file" },
        sink,
        options: {
          origin: "http://test",
          frontendUrl: "http://localhost:3000",
        },
      }),
    ).rejects.toThrow("unsupported file");

    expect(sink.events).toEqual([]);
    expect(runRegistry.has("s-bad-file")).toBe(false);
  });

  it("invariant: reaches onFinish when prepareChatTurn throws", async () => {
    mockPrepareChatTurn.mockRejectedValueOnce(new Error("Workspace missing"));

    const sink = new RecordingSink();
    await expect(
      runner.stream({
        scope,
        input: baseInput,
        sink,
        options: {
          origin: "http://test",
          frontendUrl: "http://localhost:3000",
        },
      }),
    ).rejects.toThrow("Workspace missing");

    expect(sink.names()).toEqual(["onStart", "onFinish"]);
    const finish = sink.events[1] as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("failed");
    expect(finish.error).toBe("Workspace missing");
    expect(mockStreamText).not.toHaveBeenCalled();
  });
});

describe("AgentRunner — duplicate submission for a live run", () => {
  let runner: AgentRunner;
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
    resetStreamHarness();
  });

  // why: clearAllMocks keeps a queued mockResolvedValueOnce; these runs leave one unconsumed
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
      options: { origin: "http://test", frontendUrl: "http://localhost:3000" },
    });
  };

  it("rejects the duplicate with a ConflictError (409) and writes nothing", async () => {
    const sink = new RecordingSink();
    await liveRun(sink);

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
        options: {
          origin: "http://test",
          frontendUrl: "http://localhost:3000",
        },
      }),
    ).rejects.toThrow(ConflictError);

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
        options: {
          origin: "http://test",
          frontendUrl: "http://localhost:3000",
        },
      }),
    ).rejects.toThrow(ConflictError);

    expect(sink.names()).not.toContain("onFinish");
    expect(runRegistry.has("chat-live")).toBe(true);
  });

  it("releases the claim when the start hook throws", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    const sink = new RecordingSink();
    sink.onStart = () => Promise.reject(new Error("row write failed"));

    await expect(
      runner.stream({
        scope,
        input: { ...baseInput, runId: "chat-start-throws" },
        sink,
        options: {
          origin: "http://test",
          frontendUrl: "http://localhost:3000",
        },
      }),
    ).rejects.toThrow("row write failed");

    expect(runRegistry.has("chat-start-throws")).toBe(false);
    expect(mockStreamText).not.toHaveBeenCalled();
  });

  it("answers a lost claim with its ConflictError and logs no error", async () => {
    const sink = new RecordingSink();
    sink.onStart = () => Promise.reject(new ConflictError("busy"));

    await expect(
      runner.stream({
        scope,
        input: { ...baseInput, runId: "chat-start-throws" },
        sink,
        options: {
          origin: "http://test",
          frontendUrl: "http://localhost:3000",
        },
      }),
    ).rejects.toThrow(ConflictError);

    expect(runRegistry.has("chat-start-throws")).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("a throw after the run adopts its turn", () => {
  let runner: AgentRunner;
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
  });

  afterEach(() => {
    runRegistry.unregister("chat-post-adoption");
    mockPrepareChatTurn.mockReset();
    mockStreamText.mockReset();
    vi.mocked(convertToModelMessages).mockReset().mockResolvedValue([]);
  });

  const input = { ...baseInput, runId: "chat-post-adoption" };

  const finishesOf = (sink: RecordingSink) =>
    sink.events.filter(
      (e): e is Extract<LifecycleEvent, { name: "onFinish" }> =>
        e.name === "onFinish",
    );

  it("finishes the run failed with the conversion error and releases the claim", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn({ dispose }));
    vi.mocked(convertToModelMessages).mockRejectedValueOnce(
      new Error("malformed stored part"),
    );

    const sink = new RecordingSink();
    await expect(
      runner.stream({
        scope,
        input,
        sink,
        options: {
          origin: "http://test",
          frontendUrl: "http://localhost:3000",
        },
      }),
    ).rejects.toThrow("malformed stored part");

    const finishes = finishesOf(sink);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({
      status: "failed",
      error: "malformed stored part",
    });
    expect(runRegistry.has("chat-post-adoption")).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(mockStreamText).not.toHaveBeenCalled();
  });

  it("finishes the run failed with the resolved hook's error", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn({ dispose }));
    const sink = new RecordingSink();
    sink.onResolved = () => Promise.reject(new Error("plan write failed"));

    await expect(
      runner.generate({
        scope,
        input,
        sink,
        options: { frontendUrl: "http://localhost:3000" },
      }),
    ).rejects.toThrow("plan write failed");

    const finishes = finishesOf(sink);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({
      status: "failed",
      error: "plan write failed",
    });
    expect(runRegistry.has("chat-post-adoption")).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("finishes the run failed when the model call throws before the drive takes over", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn({ dispose }));
    mockStreamText.mockImplementationOnce(() => {
      throw new Error("bad model args");
    });

    const sink = new RecordingSink();
    await expect(
      runner.stream({
        scope,
        input,
        sink,
        options: {
          origin: "http://test",
          frontendUrl: "http://localhost:3000",
        },
      }),
    ).rejects.toThrow("bad model args");

    const finishes = finishesOf(sink);
    expect(finishes).toHaveLength(1);
    expect(finishes[0]).toMatchObject({
      status: "failed",
      error: "bad model args",
    });
    expect(runRegistry.has("chat-post-adoption")).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("lets an immediate retry into the same Chat run rather than answering 409", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    vi.mocked(convertToModelMessages).mockRejectedValueOnce(
      new Error("malformed stored part"),
    );
    await expect(
      runner.generate({
        scope,
        input,
        sink: new RecordingSink(),
        options: { frontendUrl: "http://localhost:3000" },
      }),
    ).rejects.toThrow("malformed stored part");

    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockReturnValueOnce(streamResultOf(fakeGenerateResult));
    const retry = new RecordingSink();
    const result = await runner.generate({
      scope,
      input,
      sink: retry,
      options: { frontendUrl: "http://localhost:3000" },
    });

    expect(result.text).toBe("ok");
    expect(finishesOf(retry)[0]?.status).toBe("succeeded");
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
    mockStreamText.mockImplementation(hangingUntilAbort);

    const sink = new RecordingSink();
    const inFlight = runner.generate({
      scope,
      input: { ...baseInput, runId: "cancel-1" },
      sink,
      options: { frontendUrl: "http://localhost:3000" },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(runRegistry.cancel("cancel-1")).toBe(true);

    await expect(inFlight).rejects.toThrow();

    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.name).toBe("onFinish");
    expect(finish.status).toBe("cancelled");
  });

  it("disposes the turn exactly once when a run is cancelled, before onFinish", async () => {
    const sink = new RecordingSink();
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
      options: { frontendUrl: "http://localhost:3000" },
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(runRegistry.cancel("cancel-dispose")).toBe(true);
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

  it("per-run timeout produces onFinish with status=failed and TimeoutError", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockImplementation(hangingUntilAbort);

    const sink = new RecordingSink();
    const inFlight = runner.generate({
      scope,
      input: { ...baseInput, runId: "timeout-1" },
      sink,
      options: {
        frontendUrl: "http://localhost:3000",
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
      options: { frontendUrl: "http://localhost:3000" },
    });

    expect(runRegistry.cancel("ok-1")).toBe(false);
    expect(runRegistry.has("ok-1")).toBe(false);
  });
});

const tick = () => new Promise((r) => setTimeout(r, 0));

const resetStreamHarness = (): void => {
  streamHarness.queue = null;
  streamHarness.onStepEnd = undefined;
  streamHarness.onFinish = undefined;
  streamHarness.onToolExecutionEnd = undefined;
  streamHarness.messageMetadata = undefined;
  streamHarness.terminalFinishReason = undefined;
};

// why: a real stream, not a { tee } literal that lies once the pipeline changes
const emptyUIStream = () =>
  new ReadableStream({
    start: (controller) => controller.close(),
  });

const primeStreamText = () => {
  mockStreamText.mockImplementation(
    (opts: {
      onStepEnd?: (step: unknown) => void;
      onToolExecutionEnd?: (ctx: {
        toolCall: { toolCallId: string };
        toolExecutionMs: number;
      }) => void;
    }) => {
      streamHarness.onStepEnd = opts.onStepEnd;
      streamHarness.onToolExecutionEnd = opts.onToolExecutionEnd;
      return {};
    },
  );
  mockToUIMessageStream.mockImplementation(
    (uiOpts: {
      onEnd: (ctx: { messages: unknown[] }) => Promise<void> | void;
      messageMetadata: (opts: { part: MetadataPart }) => unknown;
    }) => {
      streamHarness.onFinish = uiOpts.onEnd;
      streamHarness.messageMetadata = uiOpts.messageMetadata;
      return emptyUIStream();
    },
  );
};

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

  const slowPrepare = (dispose: () => Promise<void>) =>
    mockPrepareChatTurn.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return fakeTurn({ dispose });
    });

  const timedOutRun = async (sink: RunSink, dispose: () => Promise<void>) => {
    slowPrepare(dispose);
    const inFlight = runner.generate({
      scope,
      input: { ...baseInput, runId: "late-prepare" },
      sink,
      options: {
        frontendUrl: "http://localhost:3000",
        timeouts: { perStepTimeoutMs: 5, perRunTimeoutMs: 1_000_000 },
      },
    });
    // why: keeps the rejection from surfacing as unhandled while the clock advances
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

  it("runs a closer a Contribution registered, exactly once", async () => {
    const session = await openToolSession(
      {
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
        frontendUrl: "http://localhost:3000",
        timezone: "UTC",
        sessionId: "chat-1",
      },
      undefined,
      {
        getMcp: () => Promise.resolve(null),
        saveMcpToolListing: () => Promise.resolve(),
        setMcpFetchFailedAt: () => Promise.resolve(),
      },
      { withheldToolSetIds: [], interactive: false },
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
    expect(sink.names()).toEqual(["onStart", "onFinish"]);
    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("failed");
    expect(finish.error).toMatch(/per-step timeout/);
    expect(runRegistry.has("late-prepare")).toBe(false);
  });

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

  it("fails the caller when the run was cancelled while the turn resolved", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    slowPrepare(dispose);
    const sink = new RecordingSink();
    const inFlight = runner.generate({
      scope,
      input: { ...baseInput, runId: "cancel-prepare" },
      sink,
      options: { frontendUrl: "http://localhost:3000" },
    });
    inFlight.catch(() => {});

    await vi.advanceTimersByTimeAsync(10);
    expect(runRegistry.cancel("cancel-prepare")).toBe(true);
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

  it("records a cancel that made the turn's resolution throw as cancelled", async () => {
    mockPrepareChatTurn.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 60));
      throw new Error("aborted");
    });
    const sink = new RecordingSink();
    const inFlight = runner.generate({
      scope,
      input: { ...baseInput, runId: "cancel-prepare-throws" },
      sink,
      options: { frontendUrl: "http://localhost:3000" },
    });
    inFlight.catch(() => {});

    await vi.advanceTimersByTimeAsync(10);
    expect(runRegistry.cancel("cancel-prepare-throws")).toBe(true);
    await vi.advanceTimersByTimeAsync(60);

    await expect(inFlight).rejects.toThrow("aborted");
    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("cancelled");
    expect(finish.error).toBeUndefined();
  });
});

describe("AgentRunner.stream — success & interruption", () => {
  let runner: AgentRunner;
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
    resetStreamHarness();
  });

  it("tells the sink of the run's first output once, with the reply so far", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;
    primeStreamText();

    const outputs: unknown[][] = [];
    const sink = new RecordingSink();
    const withOutput: RunSink = Object.assign(sink, {
      onOutput: (ctx: { messages: unknown[] }) => {
        outputs.push(ctx.messages);
        return Promise.resolve();
      },
    });
    await runner.stream({
      scope,
      input: { ...baseInput, runId: "s-output" },
      sink: withOutput,
      options: { origin: "http://test", frontendUrl: "http://localhost:3000" },
    });

    const text = (t: string) => ({
      id: "m1",
      role: "assistant",
      parts: [{ type: "step-start" }, { type: "text", text: t }],
    });
    queue.push({
      id: "m1",
      role: "assistant",
      parts: [{ type: "step-start" }],
    });
    await tick();
    expect(outputs).toEqual([]);

    queue.push(text("He"));
    queue.push(text("Hel"));
    queue.push(text("Hello"));
    await tick();

    expect(outputs).toEqual([[text("He")]]);
    expect(sink.names()).not.toContain("onProgress");
    runRegistry.cancel("s-output");
    queue.end();
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
      options: { origin: "http://test", frontendUrl: "http://localhost:3000" },
    });
    expect(res).toBe(streamHarness.responseSentinel);

    streamHarness.onStepEnd!({
      usage: { inputTokens: 3, outputTokens: 4 },
      toolCalls: [],
    });
    queue.push({ id: "m1", role: "assistant", parts: [] });
    await tick();
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
      options: { origin: "http://test", frontendUrl: "http://localhost:3000" },
    });

    const continued = {
      id: "msg-seed",
      role: "assistant",
      parts: [...seeded.parts, { type: "text", text: "Here you go." }],
    };
    queue.push(continued);
    await tick();
    streamHarness.onStepEnd!({ usage: {}, toolCalls: [] });
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
      options: { origin: "http://test", frontendUrl: "http://localhost:3000" },
    });

    const fresh = { id: "m1", role: "assistant", parts: [] };
    queue.push(fresh);
    await tick();
    streamHarness.onStepEnd!({ usage: {}, toolCalls: [] });
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
      options: { origin: "http://test", frontendUrl: "http://localhost:3000" },
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
      options: { origin: "http://test", frontendUrl: "http://localhost:3000" },
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
      (opts: { stopWhen: unknown[]; onStepEnd: (step: unknown) => void }) => {
        capturedStopWhen = opts.stopWhen;
        streamHarness.onStepEnd = opts.onStepEnd;
        return {};
      },
    );
    mockToUIMessageStream.mockImplementationOnce(
      (uiOpts: {
        onEnd: (ctx: { messages: unknown[] }) => Promise<void> | void;
      }) => {
        streamHarness.onFinish = uiOpts.onEnd;
        return emptyUIStream();
      },
    );

    const sink = new RecordingSink();
    await runner.stream({
      scope,
      input: { ...baseInput, runId: "s-no-detector" },
      sink,
      options: { origin: "http://test", frontendUrl: "http://localhost:3000" },
    });

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
      options: { origin: "http://test", frontendUrl: "http://localhost:3000" },
    });

    const partial = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "par" }],
    };
    queue.push(partial);
    await tick();

    expect(runRegistry.cancel("s-cancel")).toBe(true);
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

  it("finalises a cancelled run with the drive's final messages and stats", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;
    primeStreamText();

    const sink = new RecordingSink();
    await runner.stream({
      scope,
      input: { ...baseInput, runId: "s-cancel-final" },
      sink,
      options: { origin: "http://test", frontendUrl: "http://localhost:3000" },
    });

    expect(runRegistry.cancel("s-cancel-final")).toBe(true);
    await tick();
    streamHarness.onToolExecutionEnd!({
      toolCall: { toolCallId: "call-1" },
      toolExecutionMs: 1234,
    });
    streamHarness.onStepEnd!({ usage: {}, toolCalls: [] });
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
    expect(sink.names()).not.toContain("onFinish");
    queue.end();
    await tick();

    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("cancelled");
    expect(
      (finish.messages![0] as { parts: unknown[] }).parts[0],
    ).toMatchObject({ toolMetadata: { durationMs: 1234 } });
    expect(finish.stats?.steps).toBe(1);
    expect(runRegistry.has("s-cancel-final")).toBe(false);
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
        frontendUrl: "http://localhost:3000",
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
    await vi.waitFor(() =>
      expect(
        (mockStreamText.mock.calls[0][0] as { abortSignal: AbortSignal })
          .abortSignal.aborted,
      ).toBe(true),
    );
    queue.end();
    await vi.waitFor(() => expect(sink.names()).toContain("onFinish"));

    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("failed");
    expect(finish.error).toMatch(/per-run timeout/);
    expect(finish.messages).toEqual([partial]);
    expect(runRegistry.has("s-timeout")).toBe(false);
  });
});

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
      options: { origin: "http://test", frontendUrl: "http://localhost:3000" },
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

    expect(stream.metadataFor({ type: "start" })).toEqual({
      agentId: "agent-1",
      prepDurationMs: expect.any(Number) as unknown,
    });

    await stream.end();
  });

  it("still flags a truncated direct provider/model stream that has no attribution", async () => {
    const turn = fakeTurn();
    turn.resolved = {
      ...turn.resolved,
      agentId: undefined as unknown as string,
    };
    const stream = await startStream(turn);

    expect(stream.metadataFor({ type: "start" })).toEqual({
      prepDurationMs: expect.any(Number) as unknown,
    });
    expect(
      stream.metadataFor({ type: "finish", finishReason: "length" }),
    ).toEqual({ truncatedByTokenLimit: true });

    await stream.end();
  });

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
      tokenUsage: { inputTokens: 12_400, outputTokens: 180 },
      modelDurationMs: expect.any(Number) as unknown,
    });

    await stream.end();
  });
});

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
      options: { frontendUrl: "http://localhost:3000" },
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
      options: { origin: "http://test", frontendUrl: "http://localhost:3000" },
    });

    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 32000 }),
    );
  });

  it("sends no ceiling when the model declares none", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(turnWithCeiling(undefined));
    mockStreamText.mockReturnValueOnce(streamResultOf(fakeGenerateResult));

    await runner.generate({
      scope,
      input: baseInput,
      sink: new RecordingSink(),
      options: { frontendUrl: "http://localhost:3000" },
    });

    const args = mockStreamText.mock.calls[0][0] as {
      maxOutputTokens?: number;
    };
    expect(args.maxOutputTokens).toBeUndefined();
  });
});

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

  it("converts the Transcript with incomplete tool calls ignored and Sandbox uploads as notes", async () => {
    mockPrepareChatTurn.mockReset();
    mockStreamText.mockReset();
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockStreamText.mockReturnValueOnce(streamResultOf(fakeGenerateResult));

    await new AgentRunner().generate({
      scope,
      input: baseInput,
      sink: new RecordingSink(),
      options: { frontendUrl: "http://localhost:3000" },
    });

    expect(vi.mocked(convertToModelMessages)).toHaveBeenCalledWith(
      expect.anything(),
      { ignoreIncompleteToolCalls: true, convertDataPart },
    );
  });

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
