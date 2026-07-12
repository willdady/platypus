import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPrepareChatTurn, mockGenerateText, mockStreamText, streamHarness } =
  vi.hoisted(() => {
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
        while ((r = this.resolvers.shift()))
          r({ value: undefined, done: true });
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
      mockGenerateText: vi.fn(),
      mockStreamText: vi.fn(),
      streamHarness: {
        AsyncQueue,
        queue: null as InstanceType<typeof AsyncQueue> | null,
        // The AI SDK callbacks the runner registers; captured so the test can
        // drive step-completion and stream-completion by hand.
        onStepFinish: undefined as ((step: unknown) => void) | undefined,
        onFinish: undefined as
          ((ctx: { messages: unknown[] }) => Promise<void> | void) | undefined,
        responseSentinel: { __isResponse: true },
        // The response-branch stream handed to createUIMessageStreamResponse.
        // Captured so a test can read the raw chunks the writer emitted (e.g. the
        // live compact_context in-progress/done pair).
        responseStream: null as ReadableStream<unknown> | null,
      },
    };
  });

vi.mock("../services/chat-execution.ts", () => ({
  prepareChatTurn: mockPrepareChatTurn,
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    generateText: mockGenerateText,
    streamText: mockStreamText,
    convertToModelMessages: vi.fn().mockReturnValue([]),
    createIdGenerator: vi.fn().mockReturnValue(() => "msg-1"),
    stepCountIs: vi.fn(),
    readUIMessageStream: () => streamHarness.queue,
    createUIMessageStreamResponse: (opts: {
      stream: ReadableStream<unknown>;
    }) => {
      streamHarness.responseStream = opts.stream;
      return streamHarness.responseSentinel;
    },
  };
});

vi.mock("../logger.ts", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { AgentRunner, stripCompactionTraceParts } from "./agent-runner.ts";
import { buildTier2PrepareStep } from "./compaction.ts";
import type { UIMessageChunk } from "ai";
import { runRegistry, TimeoutError } from "./run-registry.ts";
import type { ResolvedRunPlan, RunInput, RunSink } from "./types.ts";
import type { PlatypusUIMessage } from "../types.ts";
import type { WorkspaceScope } from "../scope.ts";

type LifecycleEvent =
  | { name: "onStart"; runId: string }
  | { name: "onResolved"; runId: string; plan: ResolvedRunPlan }
  | { name: "onProgress"; runId: string }
  | {
      name: "onFinish";
      runId: string;
      status: string;
      error?: string;
      messages?: unknown[];
    };

class RecordingSink implements RunSink {
  events: LifecycleEvent[] = [];

  onStart(ctx: { runId: string }): Promise<void> {
    this.events.push({ name: "onStart", runId: ctx.runId });
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
  }): Promise<void> {
    this.events.push({
      name: "onFinish",
      runId: ctx.runId,
      status: ctx.status,
      error: ctx.error?.message,
      messages: ctx.messages,
    });
    return Promise.resolve();
  }

  names(): string[] {
    return this.events.map((e) => e.name);
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
    recovery: {
      imageProvider: "default" as const,
      targetTokens: 1000,
      keepRecentMessages: 10,
      minPrunableChars: 2000,
      summarize: (t: string) => Promise.resolve(t),
    },
    tier2: null,
    dispose,
  };
};

const fakeGenerateResult = {
  text: "ok",
  steps: [],
  totalUsage: { inputTokens: 10, outputTokens: 5 },
};

describe("AgentRunner.generate", () => {
  let runner: AgentRunner;
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
  });

  it("runs the full lifecycle on success and disposes the turn", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn({ dispose }));
    mockGenerateText.mockResolvedValueOnce(fakeGenerateResult);

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
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("invariant: reaches onFinish and disposes the turn when generateText throws", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn({ dispose }));
    mockGenerateText.mockRejectedValueOnce(new Error("Model error"));

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

  it("forwards the resolved plan from prepareChatTurn to onResolved", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockGenerateText.mockResolvedValueOnce(fakeGenerateResult);

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
    mockGenerateText.mockImplementation(
      async ({ stopWhen }: { stopWhen: Array<(o: unknown) => unknown> }) => {
        capturedStopWhen = stopWhen;
        // The detector is the second condition (the first is the mocked
        // stepCountIs). Drive it as the SDK loop would, with repeated steps.
        await stopWhen[1]({ steps: repeatedReadSteps() });
        return fakeGenerateResult;
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
    mockGenerateText.mockImplementation(
      async ({ stopWhen }: { stopWhen: Array<(o: unknown) => unknown> }) => {
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
        await stopWhen[1]({ steps: [mk(0), mk(1), mk(2)] });
        return fakeGenerateResult;
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
  const tick = () => new Promise((r) => setTimeout(r, 0));
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
    streamHarness.queue = null;
  });

  it("invariant: reaches onFinish (failed) when prepareChatTurn throws", async () => {
    mockPrepareChatTurn.mockRejectedValueOnce(new Error("Workspace missing"));
    // prepare now fails INSIDE the UI stream's execute (opened before prepare),
    // so stream() itself resolves with the response; the run finalises "failed"
    // via runPrepare's own finalize rather than throwing out of stream().
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;

    const sink = new RecordingSink();
    const res = await runner.stream({
      scope,
      input: baseInput,
      sink,
      options: { origin: "http://test" },
    });
    expect(res).toBe(streamHarness.responseSentinel);
    // Let execute run (prepare rejects → finalize), then drain the snapshot.
    await tick();
    queue.end();
    await tick();

    expect(sink.names()).toEqual(["onStart", "onFinish"]);
    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("failed");
    expect(finish.error).toBe("Workspace missing");
    // The model stream was never invoked (prepare failed first).
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
    mockGenerateText.mockImplementation(
      async ({ abortSignal }: { abortSignal: AbortSignal }) => {
        await new Promise<never>((_, reject) => {
          if (abortSignal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          abortSignal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
        throw new Error("unreachable");
      },
    );

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

  it("cancel(unknown) returns false", () => {
    expect(runner.cancel("never-existed")).toBe(false);
  });

  it("per-run timeout produces onFinish with status=failed and TimeoutError", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockGenerateText.mockImplementation(
      async ({ abortSignal }: { abortSignal: AbortSignal }) => {
        await new Promise<never>((_, reject) => {
          abortSignal.addEventListener("abort", () =>
            reject(abortSignal.reason ?? new Error("aborted")),
          );
        });
        throw new Error("unreachable");
      },
    );

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
    // Confirm it was specifically a TimeoutError (kind="run")
    expect(finish.error).toContain("run");
  });

  it("unregisters the run after generate succeeds", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    mockGenerateText.mockResolvedValueOnce(fakeGenerateResult);

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

describe("AgentRunner.stream — success & interruption", () => {
  let runner: AgentRunner;
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
    streamHarness.queue = null;
    streamHarness.onStepFinish = undefined;
    streamHarness.onFinish = undefined;
  });

  const tick = () => new Promise((r) => setTimeout(r, 0));

  // Make streamText return a fake result whose UI-stream callbacks the test
  // can drive by hand: `onStepFinish` (per step) and `onFinish` (completion).
  const primeStreamText = () => {
    mockStreamText.mockImplementation(
      (opts: { onStepFinish: (step: unknown) => void }) => {
        streamHarness.onStepFinish = opts.onStepFinish;
        return {
          toUIMessageStream: (uiOpts: {
            onFinish: (ctx: { messages: unknown[] }) => Promise<void> | void;
          }) => {
            streamHarness.onFinish = uiOpts.onFinish;
            // The runner tees this stream, so it must be a real ReadableStream.
            // Its contents are irrelevant — the snapshot branch is driven via the
            // mocked readUIMessageStream (streamHarness.queue), not this stream.
            return new ReadableStream<UIMessageChunk>({
              start(controller) {
                controller.close();
              },
            });
          },
        };
      },
    );
  };

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

    // streamText now runs inside the UI stream's execute (after prepare), so let
    // the eager execute reach it before driving its callbacks.
    await tick();

    // A step completes -> onProgress.
    streamHarness.onStepFinish!({
      usage: { inputTokens: 3, outputTokens: 4 },
      toolCalls: [],
    });
    // The server-side snapshot branch delivers the final assistant message,
    // updating state.messages; ending the queue drains the consumer, which
    // finalises the run (the runner does not use toUIMessageStream's onFinish).
    const finalMessage = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }],
    };
    queue.push(finalMessage);
    await tick();
    queue.end();
    await tick();
    const finalMessages = [finalMessage];

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
            // Must be a real ReadableStream — the runner tees it.
            return new ReadableStream<UIMessageChunk>({
              start(controller) {
                controller.close();
              },
            });
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

    // streamText runs inside execute (after prepare); wait for it to be called.
    await tick();

    // Only the step ceiling — no no-progress condition for interactive runs.
    expect(capturedStopWhen).toHaveLength(1);

    // Ending the snapshot queue drains the consumer and finalises the run
    // (the runner does not use toUIMessageStream's onFinish).
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
    // The abort ends the UI stream; the snapshot consumer drains and finalises.
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
    await new Promise((r) => setTimeout(r, 30));
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

// Smoke test the TimeoutError export so the type stays public-importable
describe("AgentRunner timeout types", () => {
  it("TimeoutError remains an Error subclass", () => {
    const e = new TimeoutError("x", "run");
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe("run");
  });
});

describe("AgentRunner.stream — live compaction trace (ADR-0012 §Compaction trace in the timeline)", () => {
  let runner: AgentRunner;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  beforeEach(() => {
    runner = new AgentRunner();
    vi.clearAllMocks();
    streamHarness.queue = null;
    streamHarness.responseStream = null;
  });

  // Read the response-branch chunks the writer emitted (captured via the
  // createUIMessageStreamResponse mock). Filters to the fields the assertions
  // need; the merged model stream is empty in these tests.
  const collectResponse = async (): Promise<
    Array<{ type: string } & Record<string, unknown>>
  > => {
    const stream = streamHarness.responseStream;
    if (!stream) throw new Error("no response stream captured");
    const out: Array<{ type: string } & Record<string, unknown>> = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value as { type: string } & Record<string, unknown>);
    }
    return out;
  };

  const primeEmptyStreamText = () => {
    mockStreamText.mockImplementation(() => ({
      // Honor `sendStart` so the suppression path is actually exercised: the
      // merged model stream emits its own `start` unless the caller passes
      // sendStart:false. When a compaction spinner already opened the message,
      // production sets sendStart:false — if that regressed, this mock would
      // emit a second `start` and the "exactly one start" assertion would fail.
      toUIMessageStream: (opts?: { sendStart?: boolean }) =>
        new ReadableStream<UIMessageChunk>({
          start(controller) {
            if (opts?.sendStart !== false) {
              controller.enqueue({ type: "start" });
            }
            controller.close();
          },
        }),
    }));
  };

  it("writes in-progress before, and done after, the model stream — paired ids and split stats", async () => {
    // prepareChatTurn fires the summarize-start callback mid-prepare (in-progress
    // chunk) and returns a turn carrying the finished trace (done chunk).
    mockPrepareChatTurn.mockImplementationOnce(
      (input: {
        onCompactionSummarizeStart?: (b: {
          tokensBefore: number;
          messagesBefore: number;
        }) => void;
      }) => {
        input.onCompactionSummarizeStart?.({
          tokensBefore: 1000,
          messagesBefore: 12,
        });
        return {
          ...fakeTurn(),
          compactionTrace: {
            messagesDropped: 5,
            summaryExcerpt: "did things",
            tokensBefore: 1000,
            tokensAfter: 400,
            messagesBefore: 12,
          },
        };
      },
    );
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;
    primeEmptyStreamText();

    const sink = new RecordingSink();
    await runner.stream({
      scope,
      input: { ...baseInput, runId: "s-trace" },
      sink,
      options: { origin: "http://test" },
    });
    // Let execute run to completion, then settle the snapshot drain.
    await tick();
    queue.end();
    await tick();

    const chunks = await collectResponse();
    const startIdx = chunks.findIndex((c) => c.type === "start");
    const inIdx = chunks.findIndex((c) => c.type === "tool-input-available");
    const outIdx = chunks.findIndex((c) => c.type === "tool-output-available");
    // The message opens with a `start` BEFORE the in-progress chunk, so the
    // streaming message carries a stable id from its first client-visible chunk
    // (no re-key flicker when the model stream lands ~1s later). Exactly one
    // start: the merged model stream suppresses its own (sendStart:false).
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(inIdx).toBeGreaterThan(startIdx);
    expect(chunks.filter((c) => c.type === "start")).toHaveLength(1);
    expect(outIdx).toBeGreaterThan(inIdx); // in-progress precedes done

    const inChunk = chunks[inIdx];
    expect(inChunk.toolName).toBe("compact_context");
    expect(inChunk.input).toEqual({ tokensBefore: 1000, messagesBefore: 12 });

    const outChunk = chunks[outIdx];
    // Paired to the same tool call so the badge flips in place.
    expect(outChunk.toolCallId).toBe(inChunk.toolCallId);
    expect(outChunk.output).toEqual({
      tokensAfter: 400,
      tokensSaved: 600,
      reductionPct: 60,
      messagesDropped: 5,
      summaryExcerpt: "did things",
    });
  });

  it("emits no compact_context chunk when the turn produced no trace", async () => {
    mockPrepareChatTurn.mockResolvedValueOnce(fakeTurn());
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;
    primeEmptyStreamText();

    const sink = new RecordingSink();
    await runner.stream({
      scope,
      input: { ...baseInput, runId: "s-no-trace" },
      sink,
      options: { origin: "http://test" },
    });
    await tick();
    queue.end();
    await tick();

    const chunks = await collectResponse();
    expect(chunks.some((c) => c.type.startsWith("tool-"))).toBe(false);
  });

  it("closes a fired spinner with a degraded Done when the summary produced no trace", async () => {
    // Summarize started (in-progress written) but the turn returns no trace
    // (CAS race / swallowed throw). A terminal chunk must still follow.
    mockPrepareChatTurn.mockImplementationOnce(
      (input: {
        onCompactionSummarizeStart?: (b: {
          tokensBefore: number;
          messagesBefore: number;
        }) => void;
      }) => {
        input.onCompactionSummarizeStart?.({
          tokensBefore: 800,
          messagesBefore: 9,
        });
        return { ...fakeTurn() }; // no compactionTrace
      },
    );
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;
    primeEmptyStreamText();

    const sink = new RecordingSink();
    await runner.stream({
      scope,
      input: { ...baseInput, runId: "s-degraded" },
      sink,
      options: { origin: "http://test" },
    });
    await tick();
    queue.end();
    await tick();

    const chunks = await collectResponse();
    const inChunk = chunks.find((c) => c.type === "tool-input-available");
    const outChunk = chunks.find((c) => c.type === "tool-output-available");
    expect(inChunk).toBeDefined();
    // Terminal chunk present so the badge never hangs on "Running".
    expect(outChunk).toBeDefined();
    expect(outChunk!.toolCallId).toBe(inChunk!.toolCallId);
    expect(outChunk!.output).toMatchObject({
      note: "Context compaction ran; summary not persisted this turn.",
    });
  });

  it("flips a fired spinner to Error when prepare throws after summarize started", async () => {
    // Spinner written (summarize began), then prepare throws (e.g. a post-summary
    // step fails). The execute catch must emit a terminal tool-output-error so the
    // badge flips to Error instead of hanging, and the run finalises "failed".
    mockPrepareChatTurn.mockImplementationOnce(
      (input: {
        onCompactionSummarizeStart?: (b: {
          tokensBefore: number;
          messagesBefore: number;
        }) => void;
      }) => {
        input.onCompactionSummarizeStart?.({
          tokensBefore: 700,
          messagesBefore: 8,
        });
        throw new Error("prepare failed after summarize");
      },
    );
    const queue = new streamHarness.AsyncQueue();
    streamHarness.queue = queue;

    const sink = new RecordingSink();
    const res = await runner.stream({
      scope,
      input: { ...baseInput, runId: "s-error" },
      sink,
      options: { origin: "http://test" },
    });
    expect(res).toBe(streamHarness.responseSentinel);
    await tick();
    queue.end();
    await tick();

    const chunks = await collectResponse();
    const inChunk = chunks.find((c) => c.type === "tool-input-available");
    const errChunk = chunks.find((c) => c.type === "tool-output-error");
    expect(inChunk).toBeDefined();
    // Terminal error chunk paired to the same tool call so the badge flips in place.
    expect(errChunk).toBeDefined();
    expect(errChunk!.toolCallId).toBe(inChunk!.toolCallId);
    expect(errChunk!.errorText).toBe("Context compaction failed.");
    // The manual `start` is closed by a terminal `finish` (after the error
    // chunk) so the streaming message is a matched start/finish pair — the
    // merged model stream that normally emits the finish never ran here.
    expect(chunks.filter((c) => c.type === "start")).toHaveLength(1);
    const errIdx = chunks.findIndex((c) => c.type === "tool-output-error");
    const finishIdx = chunks.findIndex((c) => c.type === "finish");
    expect(finishIdx).toBeGreaterThan(errIdx);
    // The model stream never ran, and the run finalised "failed".
    expect(mockStreamText).not.toHaveBeenCalled();
    const finish = sink.events.at(-1) as Extract<
      LifecycleEvent,
      { name: "onFinish" }
    >;
    expect(finish.status).toBe("failed");
  });
});

describe("stripCompactionTraceParts", () => {
  const traceMessage = (id: string): PlatypusUIMessage =>
    ({
      id,
      role: "assistant",
      parts: [
        {
          type: "tool-compact_context",
          toolCallId: `${id}-call`,
          state: "output-available",
          input: { messagesDropped: 2 },
          output: { messagesDropped: 2 },
        },
      ],
    }) as unknown as PlatypusUIMessage;

  it("drops a trace-only assistant message entirely (never replayed to the model)", () => {
    const messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      traceMessage("t1"),
    ] as unknown as PlatypusUIMessage[];

    const out = stripCompactionTraceParts(messages);
    expect(out.map((m) => m.id)).toEqual(["u1"]);
  });

  it("strips only the trace part from an assistant message with real content", () => {
    const messages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-compact_context",
            toolCallId: "a1-call",
            state: "output-available",
            input: {},
            output: {},
          },
          { type: "text", text: "answer" },
        ],
      },
    ] as unknown as PlatypusUIMessage[];

    const out = stripCompactionTraceParts(messages);
    expect(out).toHaveLength(1);
    expect(out[0].parts.map((p) => p.type)).toEqual(["text"]);
  });

  it("returns the same array reference when nothing to strip", () => {
    const messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ] as unknown as PlatypusUIMessage[];
    expect(stripCompactionTraceParts(messages)).toBe(messages);
  });
});

describe("buildTier2PrepareStep", () => {
  const makeCtx = (triggerTokens = 100) => ({
    triggerTokens,
    targetTokens: 50,
    keepRecentMessages: 4,
    minPrunableChars: 100,
    imageProvider: "default" as const,
    summarize: vi.fn().mockResolvedValue("summary"),
    summarizerWindow: undefined,
  });

  // Invoke a PrepareStepFunction supplying only the field under test; the
  // callback ignores every other option. The synthetic options object is cast
  // to the parameter type because AI SDK v7 requires many more fields
  // (instructions, runtimeContext, toolsContext, …) that this test never reads.
  const callStep = (
    fn: ReturnType<typeof buildTier2PrepareStep>,
    messages: import("ai").ModelMessage[],
  ) =>
    fn({
      messages,
      steps: [],
      stepNumber: 0,
      model: {} as never,
    } as unknown as Parameters<typeof fn>[0]);

  const shortMessages: import("ai").ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    },
  ];

  // 6 assistant/tool pairs where each tool result carries 1200 chars of text
  // (≈ 300 tokens each via char/4). Total ≈ 1800+ tokens > any reasonable
  // triggerTokens threshold used in these tests.
  const longMessages = (): import("ai").ModelMessage[] => {
    const msgs: import("ai").ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "start" }] },
    ];
    for (let i = 0; i < 6; i++) {
      msgs.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: `tc${i}`,
            toolName: "tool",
            input: {},
          },
        ],
      });
      msgs.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `tc${i}`,
            toolName: "tool",
            // Must use typed output shape so tokenEstimator counts the value.
            output: { type: "text" as const, value: "x".repeat(1200) },
          },
        ],
      });
    }
    return msgs;
  };

  it("returns undefined when messages are below triggerTokens (ADR-0012 §Sub-agents)", async () => {
    const fn = buildTier2PrepareStep(makeCtx(10_000));
    const result = await callStep(fn, shortMessages);
    expect(result).toBeUndefined();
  });

  it("compacts when messages exceed triggerTokens", async () => {
    const msgs = longMessages();
    const ctx = makeCtx(1);
    const fn = buildTier2PrepareStep(ctx);
    const result = await callStep(fn, msgs);
    expect(result?.messages).toBeDefined();
    const out = result!.messages!;
    expect(out.length).toBeLessThan(msgs.length);
    // Stage 2 summarizes the dropped prefix.
    expect(ctx.summarize).toHaveBeenCalled();
    // First surviving message is the synthetic summary (role "user"); the one
    // after it starts the kept tail and must not be an orphaned tool result
    // (its assistant tool-call would have been dropped into the prefix).
    expect(out[1]?.role).not.toBe("tool");
  });

  it("returns undefined when prefix is empty (no-op, ADR-0012 §Sub-agents)", async () => {
    // Two messages, keepRecentMessages 4 → no prefix to summarize →
    // compactModelMessages drops nothing → prepareStep returns undefined so the
    // SDK proceeds unchanged, and the summarizer is never called.
    const ctx = makeCtx(1);
    const fn = buildTier2PrepareStep(ctx);
    const result = await callStep(fn, shortMessages);
    expect(result).toBeUndefined();
    expect(ctx.summarize).not.toHaveBeenCalled();
  });

  it("does not call summarize when estimate is below triggerTokens", async () => {
    const ctx = makeCtx(10_000);
    const fn = buildTier2PrepareStep(ctx);
    await callStep(fn, shortMessages);
    expect(ctx.summarize).not.toHaveBeenCalled();
  });
});
