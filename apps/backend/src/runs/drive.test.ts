import { describe, it, expect, beforeEach } from "vitest";
import { simulateReadableStream, type Tool } from "ai";
import type {
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { startRun } from "./run-lifecycle.ts";
import { runRegistry, TimeoutError } from "./run-registry.ts";
import {
  driveChat,
  driveDelegate,
  driveOnce,
  failBeforeDrive,
} from "./drive.ts";
import { RunEventRecorder } from "./run-events.ts";
import type { PlatypusUIMessage } from "../types.ts";
import type { RunStats, RunStatus } from "./types.ts";
import { CLEARED_TOOL_RESULT_MARKER } from "@platypus/schemas";
import type { ModelMessage } from "ai";
import { ANSWER_STEP_INSTRUCTION } from "./answer-step.ts";
import type { RunPlan } from "./run-plan.ts";
import { TEST_USAGE_MODEL } from "./run-plan.test-fixtures.ts";
import {
  currentCausingAgents,
  withCausation,
  type AgentChain,
} from "../event-causation.ts";

const USAGE = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};

const text = (id: string, ...deltas: string[]): LanguageModelV3StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id },
  ...deltas.map((delta) => ({ type: "text-delta" as const, id, delta })),
  { type: "text-end", id },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: USAGE,
  },
];

const modelOf = (...steps: LanguageModelV3StreamPart[][]) => {
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

const finishingModel = (
  overrides: {
    finishReason?: LanguageModelV3FinishReason;
    usage?: LanguageModelV3Usage;
    text?: string;
  } = {},
): MockLanguageModelV3 =>
  modelOf([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: overrides.text ?? "ok" },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: overrides.finishReason ?? { unified: "stop", raw: "stop" },
      usage: overrides.usage ?? USAGE,
    },
  ]);

const STUCK_TOOL = "probe";

const stuckStreamingModel = () => {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: () => {
      const id = `tc${(index += 1)}`;
      return Promise.resolve({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "tool-input-start", id, toolName: STUCK_TOOL },
            { type: "tool-input-end", id },
            {
              type: "tool-call",
              toolCallId: id,
              toolName: STUCK_TOOL,
              input: "{}",
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
              usage: USAGE,
            },
          ],
        }),
      });
    },
  });
};

const startRecordedRun = (timeouts?: {
  perStepTimeoutMs?: number;
  perRunTimeoutMs?: number;
}) => {
  const outcome: Array<{ status: RunStatus; error?: Error; stats: RunStats }> =
    [];
  const run = startRun({
    runId: `drive-${Math.random().toString(36).slice(2)}`,
    timeouts,
    onTerminate: ({ status, error, stats }) => {
      outcome.push({ status, error, stats });
    },
  });
  return { run, outcome };
};

const planOf = (model: MockLanguageModelV3) => ({
  model,
  usageModel: TEST_USAGE_MODEL,
  tools: {},
  maxSteps: 3,
});

const stuckPlanOf = (model: MockLanguageModelV3) => ({
  model,
  usageModel: TEST_USAGE_MODEL,
  tools: {
    [STUCK_TOOL]: {
      inputSchema: z.object({}),
      execute: () => Promise.resolve("the same answer every time"),
    },
  } as unknown as Record<string, Tool>,
  maxSteps: 12,
});

const oneStepPlanOf = (model: MockLanguageModelV3) => ({
  ...stuckPlanOf(model),
  maxSteps: 1,
});

const causationProbePlan = (model: MockLanguageModelV3) => {
  const seen: AgentChain[] = [];
  const plan = {
    model,
    usageModel: TEST_USAGE_MODEL,
    maxSteps: 5,
    tools: {
      probe: {
        inputSchema: z.object({}),
        execute: () => {
          seen.push(currentCausingAgents());
          return "ok";
        },
      },
    } as unknown as Record<string, Tool>,
  };
  return { plan, seen };
};

const streamingToolThenStopModel = (): MockLanguageModelV3 => {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: () => {
      index += 1;
      if (index === 1) {
        return Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-input-start", id: "tc1", toolName: "probe" },
              { type: "tool-input-end", id: "tc1" },
              {
                type: "tool-call",
                toolCallId: "tc1",
                toolName: "probe",
                input: "{}",
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool_calls" },
                usage: USAGE,
              },
            ],
          }),
        });
      }
      return Promise.resolve({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            ...text("t1", "done"),
          ],
        }),
      });
    },
  });
};

describe("driveOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the text and stats and finishes the run as succeeded", async () => {
    const { run, outcome } = startRecordedRun();

    const { text: textOut, stats } = await driveOnce({
      plan: planOf(finishingModel()),
      run,
      prompt: "hi",
    });

    expect(textOut).toBe("ok");
    expect(stats.steps).toBe(1);
    expect(outcome).toHaveLength(1);
    expect(outcome[0].status).toBe("succeeded");
    expect(runRegistry.has(run.handle.runId)).toBe(false);
  });

  it("finishes the run as succeeded when folding the reply throws", async () => {
    const { run, outcome } = startRecordedRun();
    const { plan } = causationProbePlan(streamingToolThenStopModel());

    const { text: answer } = await driveOnce({
      plan,
      run,
      prompt: "hi",
      onSnapshot: () => {
        throw new Error("fold broke");
      },
    });

    expect(answer).toBe("done");
    expect(outcome[0].status).toBe("succeeded");
  });

  it("hands over the reply as it grows, tool calls and results included", async () => {
    const { run } = startRecordedRun();
    const { plan } = causationProbePlan(streamingToolThenStopModel());
    const snapshots: PlatypusUIMessage[] = [];

    await driveOnce({
      plan,
      run,
      prompt: "hi",
      onSnapshot: (message) => snapshots.push(message),
    });

    expect(snapshots.length).toBeGreaterThan(1);
    const ids = new Set(snapshots.map((m) => m.id));
    expect(ids.size).toBe(1);
    const reply = snapshots.at(-1);
    expect(reply?.role).toBe("assistant");
    expect(reply?.id).not.toBe("");
    expect(reply?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-probe",
          toolCallId: "tc1",
          state: "output-available",
          output: "ok",
        }),
        expect.objectContaining({ type: "text", text: "done" }),
      ]),
    );
  });

  it("pins the statistics a multi-step run reports", async () => {
    const { run, outcome } = startRecordedRun();

    const { stats } = await driveOnce({
      plan: stuckPlanOf(streamingToolThenStopModel()),
      run,
      prompt: "hi",
    });

    expect(stats).toEqual({
      steps: 2,
      toolCalls: [{ name: STUCK_TOOL, count: 1 }],
      inputTokens: 20,
      outputTokens: 8,
      contextOccupancy: 10,
    });
    expect(outcome[0].stats).toEqual({
      ...stats,
      usageByModel: [{ ...TEST_USAGE_MODEL, inputTokens: 20, outputTokens: 8 }],
    });
  });

  it("reports the same statistics a streamed drive accumulates", async () => {
    const headless = startRecordedRun();
    await driveOnce({
      plan: stuckPlanOf(streamingToolThenStopModel()),
      run: headless.run,
      prompt: "hi",
    });

    const streamed = startRecordedRun();
    const drive = driveDelegate({
      plan: stuckPlanOf(streamingToolThenStopModel()),
      run: streamed.run,
      prompt: "hi",
      agentId: "sub-1",
    });
    for await (const _ of drive.snapshots) void _;
    await drive.done;

    expect(streamed.outcome[0].stats).toEqual(headless.outcome[0].stats);
  });

  it("records the output ceiling cutoff on the run's stats", async () => {
    const { run, outcome } = startRecordedRun();

    const { stats } = await driveOnce({
      plan: planOf(
        finishingModel({
          finishReason: { unified: "length", raw: "max_tokens" },
        }),
      ),
      prompt: "hi",
      run,
    });

    expect(stats.truncatedByTokenLimit).toBe(true);
    expect(outcome[0].status).toBe("succeeded");
    expect(outcome[0].stats).toMatchObject({ truncatedByTokenLimit: true });
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "  \n "],
  ])(
    "finishes as failed when the output ceiling leaves the answer %s",
    async (_, answer) => {
      const { run, outcome } = startRecordedRun();

      const { stats } = await driveOnce({
        plan: planOf(
          finishingModel({
            finishReason: { unified: "length", raw: "max_tokens" },
            text: answer,
          }),
        ),
        prompt: "hi",
        run,
      });

      expect(stats.truncatedByTokenLimit).toBe(true);
      expect(outcome[0].status).toBe("failed");
      expect(outcome[0].error?.message).toMatch(/output limit/);
      expect(outcome[0].error?.message).toMatch(/Max output tokens/);
      expect(outcome[0].stats).toMatchObject({ truncatedByTokenLimit: true });
    },
  );

  it("carries cached read and write counts onto the run's stats", async () => {
    const { run, outcome } = startRecordedRun();

    const { stats } = await driveOnce({
      plan: planOf(
        finishingModel({
          usage: {
            inputTokens: {
              total: 920,
              noCache: 20,
              cacheRead: 900,
              cacheWrite: 0,
            },
            outputTokens: { total: 4, text: 4, reasoning: undefined },
          },
        }),
      ),
      prompt: "hi",
      run,
    });

    expect(stats.cacheReadTokens).toBe(900);
    expect(stats.cacheWriteTokens).toBe(0);
    expect(outcome[0].stats).toMatchObject({
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    });
  });

  it("keeps no cache key when the Provider reports no cache detail", async () => {
    const { run } = startRecordedRun();

    const { stats } = await driveOnce({
      plan: planOf(finishingModel()),
      prompt: "hi",
      run,
    });

    expect(stats).not.toHaveProperty("cacheReadTokens");
    expect(stats).not.toHaveProperty("cacheWriteTokens");
  });

  it("finishes as failed and rethrows when the model call throws", async () => {
    const { run, outcome } = startRecordedRun();
    const model = new MockLanguageModelV3({
      doStream: () => {
        throw new Error("provider exploded");
      },
    });

    await expect(
      driveOnce({ plan: planOf(model), run, prompt: "hi" }),
    ).rejects.toThrow("provider exploded");

    expect(outcome).toHaveLength(1);
    expect(outcome[0].status).toBe("failed");
    expect(outcome[0].error?.message).toBe("provider exploded");
  });

  it("finishes as cancelled when the run is stopped while generating", async () => {
    const { run, outcome } = startRecordedRun();
    const model = new MockLanguageModelV3({
      doStream: () =>
        new Promise<never>((_, reject) => {
          run.handle.signal.addEventListener("abort", () =>
            reject(run.handle.signal.reason ?? new Error("aborted")),
          );
        }),
    });

    const inflight = driveOnce({ plan: planOf(model), run, prompt: "hi" });
    await new Promise((r) => setTimeout(r, 0));
    runRegistry.cancel(run.handle.runId);

    await expect(inflight).rejects.toThrow();
    expect(outcome[0].status).toBe("cancelled");
  });

  it("finishes as failed with a no-progress error when the model stops progressing", async () => {
    const { run, outcome } = startRecordedRun();

    await driveOnce({
      plan: stuckPlanOf(stuckStreamingModel()),
      run,
      prompt: "hi",
    });

    expect(outcome[0].status).toBe("failed");
    expect(outcome[0].error?.name).toBe("NoProgressError");
    expect(outcome[0].error?.message).toMatch(
      new RegExp(`no_progress:.*${STUCK_TOOL}`),
    );
    expect(outcome[0].stats).not.toHaveProperty("stoppedAtStepLimit");
  });

  it("records the step-ceiling stop on the run's stats", async () => {
    const { run, outcome } = startRecordedRun();

    const { text: answer, stats } = await driveOnce({
      plan: oneStepPlanOf(stuckStreamingModel()),
      run,
      prompt: "hi",
    });

    expect(answer).toBe("");
    expect(stats.stoppedAtStepLimit).toBe(true);
    expect(outcome[0].status).toBe("succeeded");
    expect(outcome[0].stats).toMatchObject({ stoppedAtStepLimit: true });
  });

  it("records nothing on a run the model finished", async () => {
    const { run, outcome } = startRecordedRun();

    const { stats } = await driveOnce({
      plan: planOf(finishingModel()),
      run,
      prompt: "hi",
    });

    expect(stats).not.toHaveProperty("stoppedAtStepLimit");
    expect(outcome[0].stats).not.toHaveProperty("stoppedAtStepLimit");
  });

  it("establishes its agent's causation chain for the tools it runs", async () => {
    const { run } = startRecordedRun();
    const { plan, seen } = causationProbePlan(streamingToolThenStopModel());

    await driveOnce({ plan, run, prompt: "hi", agentId: "agent-9" });

    expect(seen.length).toBeGreaterThan(0);
    for (const chain of seen) expect(chain).toEqual(["agent-9"]);
  });

  it("runs uncaused when no agent id is given", async () => {
    const { run } = startRecordedRun();
    const { plan, seen } = causationProbePlan(streamingToolThenStopModel());

    await driveOnce({ plan, run, prompt: "hi" });

    expect(seen.length).toBeGreaterThan(0);
    for (const chain of seen) expect(chain).toEqual([]);
  });
});

describe("driveDelegate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("consumes the stream, keeps the latest message and finishes succeeded", async () => {
    const { run, outcome } = startRecordedRun();
    const drive = driveDelegate({
      plan: planOf(modelOf(text("t1", "Hello", " world"))),
      run,
      prompt: "hi",
      agentId: "sub-1",
    });

    const seen: unknown[] = [];
    for await (const message of drive.snapshots) seen.push(message);
    const result = await drive.done;

    expect(seen.length).toBeGreaterThan(0);
    const parts = result.latest?.parts ?? [];
    const textOut = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(textOut).toBe("Hello world");
    expect(result.failure).toBeUndefined();
    expect(result.status).toBe("succeeded");
    expect(outcome[0].status).toBe("succeeded");
  });

  it("flags the run when the terminal finish hit the output ceiling", async () => {
    const { run, outcome } = startRecordedRun();
    const model = new MockLanguageModelV3({
      doStream: () =>
        Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "half" },
              { type: "text-end", id: "t1" },
              {
                type: "finish",
                finishReason: { unified: "length", raw: "max_tokens" },
                usage: USAGE,
              },
            ],
          }),
        }),
    });
    const drive = driveDelegate({
      plan: planOf(model),
      run,
      prompt: "hi",
      agentId: "sub-1",
    });
    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;

    expect(result.truncated).toBe(true);
    expect(outcome[0].stats).toMatchObject({ truncatedByTokenLimit: true });
  });

  it("fails the run and reports the failure when its stream hits an error", async () => {
    const { run, outcome } = startRecordedRun();
    const drive = driveDelegate({
      plan: planOf(errorAfterText("upstream reset")),
      run,
      prompt: "hi",
      agentId: "sub-1",
    });
    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;

    expect(result.failure).toMatch(/upstream reset/);
    expect(result.status).toBe("failed");
    expect(outcome[0].status).toBe("failed");
  });

  it("closes its own events left open by a mid-answer failure, and only those", async () => {
    const { run } = startRecordedRun();
    const recorder = new RunEventRecorder({ runId: run.handle.runId });
    const parentEventId = recorder.open(null, { type: "delegate" });
    const drive = driveDelegate({
      plan: planOf(
        modelOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "half an answer" },
          { type: "error", error: new Error("upstream reset") },
        ]),
      ),
      run,
      prompt: "hi",
      agentId: "sub-1",
      events: { recorder, parentEventId },
    });
    for await (const _ of drive.snapshots) void _;
    await drive.done;

    const text = recorder.events.find((e) => e.type === "text");
    expect(text).toMatchObject({ parentEventId, status: "error" });
    expect(recorder.events.find((e) => e.type === "delegate")?.status).toBe(
      "running",
    );
  });

  it("keeps a step that streams for longer than the idle bound alive", async () => {
    const { run, outcome } = startRecordedRun({
      perStepTimeoutMs: 40,
      perRunTimeoutMs: 60_000,
    });
    const drive = driveDelegate({
      plan: planOf(
        new MockLanguageModelV3({
          doStream: () =>
            Promise.resolve({
              stream: simulateReadableStream({
                chunks: text("t1", ...Array<string>(10).fill("word ")),
                chunkDelayInMs: 15,
              }),
            }),
        }),
      ),
      run,
      prompt: "hi",
      agentId: "sub-1",
    });
    for await (const _ of drive.snapshots) void _;
    await drive.done;

    expect(outcome[0].status).toBe("succeeded");
  });

  it("finishes as cancelled when the run is stopped mid-stream", async () => {
    const { run, outcome } = startRecordedRun();
    const drive = driveDelegate({
      plan: planOf(modelOf(text("t1", "gone in a flash"))),
      run,
      prompt: "hi",
      agentId: "sub-1",
    });
    runRegistry.cancel(run.handle.runId);
    for await (const _ of drive.snapshots) void _;

    const result = await drive.done;
    expect(result.status).toBe("cancelled");
    expect(result.failure).toMatch(/Stopped before finishing/);
    expect(outcome[0].status).toBe("cancelled");
  });

  it("finishes as failed with a no-progress error when the model stops progressing", async () => {
    const { run, outcome } = startRecordedRun();
    const drive = driveDelegate({
      plan: stuckPlanOf(stuckStreamingModel()),
      run,
      prompt: "hi",
      agentId: "sub-1",
    });
    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;

    expect(result.status).toBe("failed");
    expect(result.failure).toMatch(new RegExp(`no_progress:.*${STUCK_TOOL}`));
    expect(outcome[0].error?.name).toBe("NoProgressError");
    expect(result.stoppedAtStepLimit).toBe(false);
    expect(outcome[0].stats).not.toHaveProperty("stoppedAtStepLimit");
  });

  it("reports the step-ceiling stop to its caller and on the run's stats", async () => {
    const { run, outcome } = startRecordedRun();
    const drive = driveDelegate({
      plan: oneStepPlanOf(stuckStreamingModel()),
      run,
      prompt: "hi",
      agentId: "sub-1",
    });
    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;

    expect(result.stoppedAtStepLimit).toBe(true);
    expect(result.status).toBe("succeeded");
    expect(outcome[0].stats).toMatchObject({ stoppedAtStepLimit: true });
  });

  it("reports no step-ceiling stop on a delegation the model finished", async () => {
    const { run, outcome } = startRecordedRun();
    const drive = driveDelegate({
      plan: planOf(modelOf(text("t1", "all done"))),
      run,
      prompt: "hi",
      agentId: "sub-1",
    });
    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;

    expect(result.stoppedAtStepLimit).toBe(false);
    expect(outcome[0].stats).not.toHaveProperty("stoppedAtStepLimit");
  });

  it("reports the stream error, not the stop reason, when a timed-out run also errored", async () => {
    const { run, outcome } = startRecordedRun({
      perRunTimeoutMs: 20,
      perStepTimeoutMs: 60_000,
    });
    const drive = driveDelegate({
      plan: planOf(errorThenEndOnAbort("upstream reset", run.handle.signal)),
      run,
      prompt: "hi",
      agentId: "sub-1",
    });
    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;

    expect(result.failure).toMatch(/upstream reset/);
    expect(result.failure).not.toMatch(/Stopped before finishing/);
    expect(outcome[0].status).toBe("failed");
    expect(outcome[0].error).toBeInstanceOf(TimeoutError);
  });

  it("extends the parent's causation chain with the delegate's agent id", async () => {
    const { run } = startRecordedRun();
    const { plan, seen } = causationProbePlan(streamingToolThenStopModel());

    let drain!: Promise<void>;
    withCausation(["agent-1"], () => {
      const drive = driveDelegate({
        plan,
        run,
        prompt: "hi",
        agentId: "sub-1",
      });
      drain = (async () => {
        for await (const _ of drive.snapshots) void _;
        await drive.done;
      })();
    });

    await drain;
    expect(seen).toEqual([["agent-1", "sub-1"]]);
  });
});

describe("failBeforeDrive", () => {
  it("fails the run with the setup failure as its error", async () => {
    const { run, outcome } = startRecordedRun();

    const result = await failBeforeDrive(run, "tools unavailable");

    expect(result).toEqual({
      status: "failed",
      failure: "tools unavailable",
      truncated: false,
      stoppedAtStepLimit: false,
    });
    expect(outcome).toHaveLength(1);
    expect(outcome[0].status).toBe("failed");
    expect(outcome[0].error?.message).toBe("tools unavailable");
  });
});

describe("driveChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not fail the run when its stream hits an error", async () => {
    const { run, outcome } = startRecordedRun();
    const drive = driveChat({
      plan: planOf(errorAfterText("upstream reset")),
      run,
      modelMessages: [{ role: "user", content: "hi" }],
    });
    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;
    await drive.response.cancel();

    expect(result.failure).toBeUndefined();
    expect(result.status).toBe("succeeded");
    expect(outcome[0].status).toBe("succeeded");
  });

  it("tells the client why a timed-out run stopped", async () => {
    const { run } = startRecordedRun({
      perRunTimeoutMs: 20,
      perStepTimeoutMs: 60_000,
    });
    const drive = driveChat({
      plan: planOf(textThenEndOnAbort(run.handle.signal)),
      run,
      modelMessages: [{ role: "user", content: "hi" }],
    });

    const chunks = await collect(drive.response);
    for await (const _ of drive.snapshots) void _;
    await drive.done;

    const errors = chunks.filter((c) => c.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].errorText).toMatch(/time limit/);
    expect(chunks.some((c) => c.type === "text-delta")).toBe(true);
  });

  it("names the idle bound when it was the per-step timeout that fired", async () => {
    const { run } = startRecordedRun({
      perStepTimeoutMs: 20,
      perRunTimeoutMs: 60_000,
    });
    const drive = driveChat({
      plan: planOf(textThenEndOnAbort(run.handle.signal)),
      run,
      modelMessages: [{ role: "user", content: "hi" }],
    });

    const chunks = await collect(drive.response);
    for await (const _ of drive.snapshots) void _;
    await drive.done;

    const errors = chunks.filter((c) => c.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].errorText).toMatch(/stopped sending output/);
  });

  it("stays silent when the run was cancelled rather than timed out", async () => {
    const { run } = startRecordedRun({
      perStepTimeoutMs: 60_000,
      perRunTimeoutMs: 60_000,
    });
    const drive = driveChat({
      plan: planOf(textThenEndOnAbort(run.handle.signal)),
      run,
      modelMessages: [{ role: "user", content: "hi" }],
    });
    const chunks: { type: string }[] = [];
    for await (const chunk of drive.response as unknown as AsyncIterable<{
      type: string;
    }>) {
      chunks.push(chunk);
      if (chunk.type === "text-delta") runRegistry.cancel(run.handle.runId);
    }
    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;

    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(result.status).toBe("cancelled");
  });

  it("adds nothing to a run that finished normally", async () => {
    const { run } = startRecordedRun();
    const drive = driveChat({
      plan: planOf(modelOf(text("t1", "Hi"))),
      run,
      modelMessages: [{ role: "user", content: "hi" }],
    });

    const chunks = await collect(drive.response);
    for await (const _ of drive.snapshots) void _;
    await drive.done;

    expect(chunks.some((c) => c.type === "error")).toBe(false);
  });

  it("marks the streamed message when the step ceiling stopped the loop", async () => {
    const { run, outcome } = startRecordedRun();
    const drive = driveChat({
      plan: oneStepPlanOf(stuckStreamingModel()),
      run,
      modelMessages: [{ role: "user", content: "hi" }],
    });

    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;
    await drive.response.cancel();

    expect(result.stoppedAtStepLimit).toBe(true);
    expect(result.messages?.at(-1)?.metadata?.stoppedAtStepLimit).toBe(true);
    expect(outcome[0].stats).toMatchObject({ stoppedAtStepLimit: true });
  });

  it("leaves the message unmarked on a turn the model finished", async () => {
    const { run } = startRecordedRun();
    const drive = driveChat({
      plan: planOf(modelOf(text("t1", "Hi"))),
      run,
      modelMessages: [{ role: "user", content: "hi" }],
    });

    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;
    await drive.response.cancel();

    expect(result.stoppedAtStepLimit).toBe(false);
    expect(result.messages?.at(-1)?.metadata ?? {}).not.toHaveProperty(
      "stoppedAtStepLimit",
    );
  });

  it("establishes the agent's causation chain for its tools", async () => {
    const { run } = startRecordedRun();
    const { plan, seen } = causationProbePlan(streamingToolThenStopModel());

    const drive = driveChat({
      plan,
      run,
      facts: { agentId: "agent-7" },
      modelMessages: [{ role: "user", content: "hi" }],
    });
    for await (const _ of drive.snapshots) void _;
    await drive.done;

    expect(seen).toEqual([["agent-7"]]);
  });
});

describe("the Step ceiling's answer step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  type Shape = "chat" | "delegate" | "trigger";

  const toolLoopPlan = (model: MockLanguageModelV3, maxSteps = 3): RunPlan => ({
    model,
    usageModel: TEST_USAGE_MODEL,
    tools: {
      [STUCK_TOOL]: {
        inputSchema: z.object({ n: z.number().optional() }),
        execute: () => Promise.resolve("same"),
      },
    },
    maxSteps,
  });

  const toolStep = (step: number): LanguageModelV3StreamPart[] => [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: `tc${step}`, toolName: STUCK_TOOL },
    { type: "tool-input-end", id: `tc${step}` },
    {
      type: "tool-call",
      toolCallId: `tc${step}`,
      toolName: STUCK_TOOL,
      input: JSON.stringify({ n: step }),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage: USAGE,
    },
  ];

  const stopStep = (...deltas: string[]): LanguageModelV3StreamPart[] => [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    ...deltas.map((delta) => ({
      type: "text-delta" as const,
      id: "t1",
      delta,
    })),
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: USAGE,
    },
  ];

  type Captured = { prompt: unknown; tools: unknown };

  const recordingModel = (
    captured: Captured[],
    chunksFor: (step: number) => LanguageModelV3StreamPart[],
  ) => {
    let index = 0;
    return new MockLanguageModelV3({
      doStream: (options: { prompt: unknown; tools?: unknown }) => {
        const step = index++;
        captured.push({ prompt: options.prompt, tools: options.tools });
        return Promise.resolve({
          stream: simulateReadableStream({ chunks: chunksFor(step) }),
        });
      },
    });
  };

  const sentInstruction = (captured: Captured): boolean =>
    JSON.stringify(captured.prompt).includes(ANSWER_STEP_INSTRUCTION);

  const sentTool = (captured: Captured): boolean =>
    JSON.stringify(captured.tools).includes(STUCK_TOOL);

  const ignoresTheInstruction = (captured: Captured[]) =>
    recordingModel(captured, (step) => toolStep(step));

  const obeysOnTheLastStep = (captured: Captured[], steps = 3) =>
    recordingModel(captured, (step) =>
      step < steps - 1 ? toolStep(step) : stopStep("answered"),
    );

  type ShapeOutcome = {
    stoppedAtStepLimit: boolean;
    stats: RunStats;
    messages?: PlatypusUIMessage[];
    text?: string;
  };

  const runShape = async (
    shape: Shape,
    plan: RunPlan,
  ): Promise<ShapeOutcome> => {
    const { run, outcome } = startRecordedRun();
    const stats = () => outcome[0].stats;
    if (shape === "chat") {
      const drive = driveChat({
        plan,
        run,
        modelMessages: [{ role: "user", content: "hi" }],
      });
      for await (const _ of drive.snapshots) void _;
      const result = await drive.done;
      await drive.response.cancel();
      return {
        stoppedAtStepLimit: result.stoppedAtStepLimit,
        stats: stats(),
        messages: result.messages,
      };
    }
    if (shape === "delegate") {
      const drive = driveDelegate({
        plan,
        run,
        prompt: "hi",
        agentId: "sub-1",
      });
      for await (const _ of drive.snapshots) void _;
      const result = await drive.done;
      return { stoppedAtStepLimit: result.stoppedAtStepLimit, stats: stats() };
    }
    const { text, stats: runStats } = await driveOnce({
      plan,
      run,
      prompt: "hi",
    });
    return {
      stoppedAtStepLimit: !!runStats.stoppedAtStepLimit,
      stats: stats(),
      text,
    };
  };

  it.each(["chat", "delegate", "trigger"] as const)(
    "tells the %s's model on the last step, and no earlier",
    async (shape) => {
      const captured: Captured[] = [];
      const { stoppedAtStepLimit, stats } = await runShape(
        shape,
        toolLoopPlan(ignoresTheInstruction(captured)),
      );

      expect(captured).toHaveLength(3);
      expect(captured.map(sentInstruction)).toEqual([false, false, true]);
      expect(captured.every(sentTool)).toBe(true);
      expect(stoppedAtStepLimit).toBe(true);
      expect(stats).toMatchObject({ stoppedAtStepLimit: true });
    },
  );

  it("keeps the instruction out of the Chat's persisted messages", async () => {
    const captured: Captured[] = [];
    const { messages } = await runShape(
      "chat",
      toolLoopPlan(ignoresTheInstruction(captured)),
    );

    expect(JSON.stringify(messages)).not.toContain(ANSWER_STEP_INSTRUCTION);
    expect(messages?.at(-1)?.metadata?.stoppedAtStepLimit).toBe(true);
  });

  it.each(["chat", "delegate", "trigger"] as const)(
    "puts the instruction on a %s's only call when the ceiling is one",
    async (shape) => {
      const captured: Captured[] = [];
      const { stoppedAtStepLimit } = await runShape(
        shape,
        toolLoopPlan(ignoresTheInstruction(captured), 1),
      );

      expect(captured).toHaveLength(1);
      expect(sentInstruction(captured[0])).toBe(true);
      expect(sentTool(captured[0])).toBe(true);
      expect(stoppedAtStepLimit).toBe(true);
    },
  );

  it.each(["chat", "delegate", "trigger"] as const)(
    "records no cutoff when the %s's model answers on the last step",
    async (shape) => {
      const captured: Captured[] = [];
      const result = await runShape(
        shape,
        toolLoopPlan(obeysOnTheLastStep(captured)),
      );

      expect(result.stoppedAtStepLimit).toBe(false);
      expect(result.stats).not.toHaveProperty("stoppedAtStepLimit");
      if (result.messages) {
        expect(JSON.stringify(result.messages)).toContain("answered");
        expect(result.messages.at(-1)?.metadata ?? {}).not.toHaveProperty(
          "stoppedAtStepLimit",
        );
      }
      if (shape === "trigger") expect(result.text).toBe("answered");
    },
  );
});

const collect = async <T>(stream: ReadableStream<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<T>) {
    out.push(chunk);
  }
  return out;
};

function textThenEndOnAbort(signal: AbortSignal) {
  return new MockLanguageModelV3({
    doStream: () =>
      Promise.resolve({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({
              type: "text-delta",
              id: "t1",
              delta: "Partial",
            });
            signal.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
        }),
      }),
  });
}

const errorParts = (message: string): LanguageModelV3StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "I'll try" },
  { type: "text-end", id: "t1" },
  { type: "error", error: new Error(message) },
];

function errorAfterText(message: string) {
  return new MockLanguageModelV3({
    doStream: () =>
      Promise.resolve({
        stream: simulateReadableStream({ chunks: errorParts(message) }),
      }),
  });
}

function errorThenEndOnAbort(message: string, signal: AbortSignal) {
  return new MockLanguageModelV3({
    doStream: () =>
      Promise.resolve({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of errorParts(message)) controller.enqueue(part);
            signal.addEventListener("abort", () => controller.close(), {
              once: true,
            });
          },
        }),
      }),
  });
}

describe("Tool-result clearing inheritance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const staleToolMessages = (n: number): ModelMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: `t${i}`,
          toolName: "read_url",
          output: {
            type: "text" as const,
            value: `page ${i} content ${"x".repeat(5_000)}`,
          },
        },
      ],
    }));

  const clearingPlanOf = (model: MockLanguageModelV3) => ({
    model,
    usageModel: TEST_USAGE_MODEL,
    tools: {},
    maxSteps: 3,
    contextWindow: 100,
    initialOccupancy: 95,
  });

  const capturingStreamModel = (record: { prompt?: unknown }) =>
    new MockLanguageModelV3({
      doStream: (options: { prompt: unknown }) => {
        record.prompt = options.prompt;
        return Promise.resolve({
          stream: simulateReadableStream({ chunks: text("t1", "ok") }),
        });
      },
    });

  it("driveChat clears stale tool results already past threshold on the first call", async () => {
    const { run } = startRecordedRun();
    const record: { prompt?: unknown } = {};
    const drive = driveChat({
      plan: clearingPlanOf(capturingStreamModel(record)),
      run,
      modelMessages: staleToolMessages(10),
    });
    for await (const _ of drive.snapshots) void _;
    await drive.done;
    await drive.response.cancel();

    expect(JSON.stringify(record.prompt)).toContain(CLEARED_TOOL_RESULT_MARKER);
  });

  it("driveDelegate clears stale tool results already past threshold on the first call", async () => {
    const { run } = startRecordedRun();
    const record: { prompt?: unknown } = {};
    const drive = driveDelegate({
      plan: clearingPlanOf(capturingStreamModel(record)),
      run,
      modelMessages: staleToolMessages(10),
      agentId: "sub-1",
    });
    for await (const _ of drive.snapshots) void _;
    await drive.done;

    expect(JSON.stringify(record.prompt)).toContain(CLEARED_TOOL_RESULT_MARKER);
  });

  it("driveOnce clears stale tool results already past threshold on the first call", async () => {
    const { run } = startRecordedRun();
    const record: { prompt?: unknown } = {};
    await driveOnce({
      plan: clearingPlanOf(capturingStreamModel(record)),
      run,
      modelMessages: staleToolMessages(10),
    });

    expect(JSON.stringify(record.prompt)).toContain(CLEARED_TOOL_RESULT_MARKER);
  });

  it("clears nothing below threshold", async () => {
    const { run } = startRecordedRun();
    const record: { prompt?: unknown } = {};
    await driveOnce({
      plan: {
        ...clearingPlanOf(capturingStreamModel(record)),
        initialOccupancy: 10,
      },
      run,
      modelMessages: staleToolMessages(10),
    });

    expect(JSON.stringify(record.prompt)).not.toContain(
      CLEARED_TOOL_RESULT_MARKER,
    );
  });
});
describe("driveOnce run events", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const toolCall = (
    id: string,
    toolName: string,
    input = "{}",
  ): LanguageModelV3StreamPart[] => [
    { type: "tool-input-start", id, toolName },
    { type: "tool-input-end", id },
    { type: "tool-call", toolCallId: id, toolName, input },
  ];

  const step = (
    parts: LanguageModelV3StreamPart[],
    unified: "stop" | "tool-calls" = "stop",
  ): LanguageModelV3StreamPart[] => [
    { type: "stream-start", warnings: [] },
    ...parts,
    { type: "finish", finishReason: { unified, raw: unified }, usage: USAGE },
  ];

  const reasonToolThenText = () =>
    modelOf(
      step(
        [
          { type: "reasoning-start", id: "r1" },
          { type: "reasoning-delta", id: "r1", delta: "thinking" },
          { type: "reasoning-end", id: "r1" },
          ...toolCall("tc1", "lookup", JSON.stringify({ q: "SECRET-INPUT" })),
        ],
        "tool-calls",
      ),
      step([
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "done" },
        { type: "text-end", id: "t1" },
      ]),
    );

  const toolsOf = (execute: (name: string) => Promise<unknown>) =>
    ({
      lookup: {
        inputSchema: z.object({ q: z.string().optional() }),
        execute: () => execute("lookup"),
      },
      fetch: {
        inputSchema: z.object({}),
        execute: () => execute("fetch"),
      },
    }) as unknown as Record<string, Tool>;

  it("records each tool call, reasoning stretch and text stretch with a start and a duration", async () => {
    const { run } = startRecordedRun();
    const events = new RunEventRecorder({ runId: run.handle.runId });

    await driveOnce({
      plan: {
        usageModel: TEST_USAGE_MODEL,
        model: reasonToolThenText(),
        tools: toolsOf(async () => {
          await sleep(20);
          return "found";
        }),
        maxSteps: 3,
      },
      run,
      prompt: "hi",
      events,
    });

    const byType = events.events.map((e) => [e.type, e.toolName, e.status]);
    expect(byType).toEqual([
      ["reasoning", null, "completed"],
      ["tool-input", "lookup", "completed"],
      ["tool-call", "lookup", "completed"],
      ["text", null, "completed"],
    ]);
    for (const event of events.events) {
      expect(event.startedAt).toBeGreaterThan(0);
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(events.events[2].durationMs).toBeGreaterThanOrEqual(15);
  });

  it("stores no tool input, tool output, reasoning or message content", async () => {
    const { run } = startRecordedRun();
    const events = new RunEventRecorder({ runId: run.handle.runId });

    await driveOnce({
      plan: {
        usageModel: TEST_USAGE_MODEL,
        model: reasonToolThenText(),
        tools: toolsOf(() => Promise.resolve("SECRET-OUTPUT".repeat(2000))),
        maxSteps: 3,
      },
      run,
      prompt: "hi",
      events,
    });

    const serialized = JSON.stringify(events.events);
    expect(serialized).not.toContain("SECRET-INPUT");
    expect(serialized).not.toContain("SECRET-OUTPUT");
    expect(serialized).not.toContain("thinking");
    expect(serialized).not.toContain("done");
  });

  it("records tool calls issued in parallel as overlapping, not sequential", async () => {
    const { run } = startRecordedRun();
    const events = new RunEventRecorder({ runId: run.handle.runId });
    const model = modelOf(
      step(
        [...toolCall("tc1", "lookup"), ...toolCall("tc2", "fetch")],
        "tool-calls",
      ),
      step([
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "done" },
        { type: "text-end", id: "t1" },
      ]),
    );

    await driveOnce({
      plan: {
        usageModel: TEST_USAGE_MODEL,
        model,
        tools: toolsOf(async () => {
          await sleep(10);
          return "ok";
        }),
        maxSteps: 3,
      },
      run,
      prompt: "hi",
      events,
    });

    const calls = events.events.filter((e) => e.type === "tool-call");
    expect(calls.map((c) => c.toolName)).toEqual(["lookup", "fetch"]);
    const [a, b] = calls;
    expect(a.startedAt).toBeLessThan(b.startedAt + b.durationMs!);
    expect(b.startedAt).toBeLessThan(a.startedAt + a.durationMs!);
  });

  it("records a failed tool call as an error status carrying the error", async () => {
    const { run } = startRecordedRun();
    const events = new RunEventRecorder({ runId: run.handle.runId });

    await driveOnce({
      plan: {
        usageModel: TEST_USAGE_MODEL,
        model: reasonToolThenText(),
        tools: toolsOf(() => Promise.reject(new Error("upstream 503"))),
        maxSteps: 3,
      },
      run,
      prompt: "hi",
      events,
    });

    const call = events.events.find((e) => e.type === "tool-call")!;
    expect(call.status).toBe("error");
    expect(call.error?.message).toContain("upstream 503");
    expect(call.error?.truncated).toBe(false);
  });

  it("ends the run as failed with an error message when the provider errors mid-stream", async () => {
    const { run, outcome } = startRecordedRun();
    const model = modelOf(step([...toolCall("tc1", "lookup")], "tool-calls"), [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "partial" },
      { type: "error", error: new Error("provider exploded mid-stream") },
    ]);

    await expect(
      driveOnce({
        plan: {
          model,
          usageModel: TEST_USAGE_MODEL,
          tools: toolsOf(() => Promise.resolve("ok")),
          maxSteps: 3,
        },
        run,
        prompt: "hi",
      }),
    ).rejects.toThrow(/provider exploded mid-stream/);

    expect(outcome).toHaveLength(1);
    expect(outcome[0].status).toBe("failed");
    expect(outcome[0].error?.message).toMatch(/provider exploded mid-stream/);
  });

  it("hands the final text over before the run is finished", async () => {
    const { run, outcome } = startRecordedRun();
    const order: string[] = [];

    const { text: textOut } = await driveOnce({
      plan: planOf(finishingModel()),
      run,
      prompt: "hi",
      onFinal: (text) => {
        order.push(`final:${text}`);
        order.push(`terminated:${outcome.length}`);
      },
    });

    expect(textOut).toBe("ok");
    expect(order).toEqual(["final:ok", "terminated:0"]);
  });
});
