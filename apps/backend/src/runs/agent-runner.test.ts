import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPrepareChatTurn, mockGenerateText, mockStreamText } = vi.hoisted(
  () => ({
    mockPrepareChatTurn: vi.fn(),
    mockGenerateText: vi.fn(),
    mockStreamText: vi.fn(),
  }),
);

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

import { AgentRunner, withToolTimestamps } from "./agent-runner.ts";
import type { UIMessageChunk } from "ai";
import { runRegistry, TimeoutError } from "./run-registry.ts";
import type { ResolvedRunPlan, RunInput, RunSink } from "./types.ts";
import type { WorkspaceScope } from "../scope.ts";

type LifecycleEvent =
  | { name: "onStart"; runId: string }
  | { name: "onResolved"; runId: string; plan: ResolvedRunPlan }
  | { name: "onProgress"; runId: string }
  | { name: "onFinish"; runId: string; status: string; error?: string };

class RecordingSink implements RunSink {
  events: LifecycleEvent[] = [];

  async onStart(ctx: { runId: string }): Promise<void> {
    this.events.push({ name: "onStart", runId: ctx.runId });
  }
  async onResolved(ctx: {
    runId: string;
    plan: ResolvedRunPlan;
  }): Promise<void> {
    this.events.push({ name: "onResolved", runId: ctx.runId, plan: ctx.plan });
  }
  async onProgress(ctx: { runId: string }): Promise<void> {
    this.events.push({ name: "onProgress", runId: ctx.runId });
  }
  async onFinish(ctx: {
    runId: string;
    status: string;
    error?: Error;
  }): Promise<void> {
    this.events.push({
      name: "onFinish",
      runId: ctx.runId,
      status: ctx.status,
      error: ctx.error?.message,
    });
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

    const resolved = sink.events.find((e) => e.name === "onResolved") as
      | Extract<LifecycleEvent, { name: "onResolved" }>
      | undefined;
    expect(resolved?.plan.resolved.agentId).toBe("agent-1");
    expect(resolved?.plan.resolved.providerId).toBe("p1");
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
    mockGenerateText.mockImplementation(async ({ abortSignal }: any) => {
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
    });

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
    mockGenerateText.mockImplementation(async ({ abortSignal }: any) => {
      await new Promise<never>((_, reject) => {
        abortSignal.addEventListener("abort", () =>
          reject(abortSignal.reason ?? new Error("aborted")),
        );
      });
      throw new Error("unreachable");
    });

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
    const finishEv = sink.events.at(-1)!;
    expect((finishEv as any).error).toContain("run");
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

// Smoke test the TimeoutError export so the type stays public-importable
describe("AgentRunner timeout types", () => {
  it("TimeoutError remains an Error subclass", () => {
    const e = new TimeoutError("x", "run");
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe("run");
  });
});

describe("withToolTimestamps", () => {
  const FIXED_NOW = "2026-05-30T12:00:00.000Z";

  const collect = async <T>(stream: ReadableStream<T>): Promise<T[]> => {
    const out: T[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
    return out;
  };

  const sourceOf = (chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> =>
    new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

  const toolInputAvailable = (
    overrides: Partial<
      Extract<UIMessageChunk, { type: "tool-input-available" }>
    > = {},
  ): UIMessageChunk =>
    ({
      type: "tool-input-available",
      toolCallId: "t1",
      toolName: "foo",
      input: { x: 1 },
      ...overrides,
    }) as UIMessageChunk;

  it("injects startedAt on tool-input-available chunks", async () => {
    const result = await collect(
      withToolTimestamps(sourceOf([toolInputAvailable()]), () => FIXED_NOW),
    );

    expect(result).toHaveLength(1);
    expect(
      (result[0] as { toolMetadata?: Record<string, unknown> }).toolMetadata,
    ).toEqual({ startedAt: FIXED_NOW });
  });

  it("preserves existing toolMetadata fields", async () => {
    const result = await collect(
      withToolTimestamps(
        sourceOf([toolInputAvailable({ toolMetadata: { custom: "value" } })]),
        () => FIXED_NOW,
      ),
    );

    expect(
      (result[0] as { toolMetadata?: Record<string, unknown> }).toolMetadata,
    ).toEqual({
      custom: "value",
      startedAt: FIXED_NOW,
    });
  });

  it("passes non-tool-input-available chunks through unchanged", async () => {
    const chunks: UIMessageChunk[] = [
      { type: "text-delta", id: "a", delta: "hello" } as UIMessageChunk,
      {
        type: "tool-output-available",
        toolCallId: "t1",
        output: { ok: true },
      } as UIMessageChunk,
      { type: "finish", finishReason: "stop" } as UIMessageChunk,
    ];

    const result = await collect(
      withToolTimestamps(sourceOf(chunks), () => "irrelevant"),
    );

    expect(result).toEqual(chunks);
  });
});
