import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockPrepareChatTurn,
  mockValidateTurnAttachments,
  mockGenerateText,
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
    generateText: mockGenerateText,
    streamText: mockStreamText,
    convertToModelMessages: vi.fn().mockReturnValue([]),
    createIdGenerator: vi.fn().mockReturnValue(() => "msg-1"),
    stepCountIs: vi.fn(),
    readUIMessageStream: () => streamHarness.queue,
    createUIMessageStreamResponse: () => streamHarness.responseSentinel,
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

import { AgentRunner } from "./agent-runner.ts";
import { runRegistry, TimeoutError } from "./run-registry.ts";
import type { ResolvedRunPlan, RunInput, RunSink } from "./types.ts";
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
            return { tee: () => [{}, {}] };
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
            return { tee: () => [{}, {}] };
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
