import { describe, it, expect, beforeEach } from "vitest";
import type { Tool } from "ai";
import type {
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
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
import type { RunStatus } from "./types.ts";
import { CLEARED_TOOL_RESULT_MARKER } from "./tool-result-clearing.ts";
import type { ModelMessage } from "ai";
import {
  currentCausingAgents,
  withCausation,
  type AgentChain,
} from "../event-causation.ts";

/**
 * The drive is the seam that owns the model drill and the terminal decision.
 * These tests drive it with a *real* AI SDK pipeline and a mock model — no
 * `AgentRunner`, no delegate tool — to lock the unit: how a run ends
 * (succeeded / failed / cancelled), when the output-ceiling cutoff is
 * recorded, which stop conditions each entry point carries, and how a streamed
 * run reports its outcome. The `AgentRunner` and sub-agent suites cover the
 * wiring on top; this is the rule's floor.
 */

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

/**
 * A one-step streaming model whose terminal finish and usage the test picks.
 * The headless drive streams too now (#647), so every drive shape is backed
 * by `doStream` and the mock generate path is gone.
 */
const finishingModel = (
  overrides: {
    finishReason?: LanguageModelV3FinishReason;
    usage?: LanguageModelV3Usage;
  } = {},
): MockLanguageModelV3 =>
  modelOf([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "ok" },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: overrides.finishReason ?? { unified: "stop", raw: "stop" },
      usage: overrides.usage ?? USAGE,
    },
  ]);

const STUCK_TOOL = "probe";

/**
 * A model that re-issues the same tool call, with the same arguments, forever
 * — the shape the no-progress detector exists to stop. Each call carries a
 * fresh `toolCallId` (the SDK wants them unique); the detector keys on tool
 * name + arguments + result, so the repeats still collide.
 */
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

/** A run observed only by recording how it ended. */
const startRecordedRun = (timeouts?: {
  perStepTimeoutMs?: number;
  perRunTimeoutMs?: number;
}) => {
  const outcome: Array<{ status: RunStatus; error?: Error; stats: unknown }> =
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
  tools: {},
  maxSteps: 3,
});

/**
 * The stuck plan's ceiling sits well above the detector's threshold (3 repeats)
 * so a trip is unambiguously the detector's doing and not the step ceiling's.
 */
const stuckPlanOf = (model: MockLanguageModelV3) => ({
  model,
  tools: {
    [STUCK_TOOL]: {
      inputSchema: z.object({}),
      execute: () => Promise.resolve("the same answer every time"),
    },
  } as unknown as Record<string, Tool>,
  maxSteps: 12,
});

/**
 * The same tool-calling loop under a ceiling of one, so the step-count stop
 * condition is what halts it — well before the detector's three repeats, which
 * is the confusion the flag has to avoid.
 */
const oneStepPlanOf = (model: MockLanguageModelV3) => ({
  ...stuckPlanOf(model),
  maxSteps: 1,
});

/** A plan whose only tool records the ambient causation chain at execute time. */
const causationProbePlan = (model: MockLanguageModelV3) => {
  const seen: AgentChain[] = [];
  const plan = {
    model,
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

/** The streamed model: one tool call then a clean stop. */
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
    expect(outcome[0].stats).toMatchObject({ truncatedByTokenLimit: true });
  });

  // Issue #734. The headless path folds usage through `computeStats`, which
  // must carry the cached-input breakdown the same way the streamed
  // accumulator does. A write of 0 is a real measurement and is kept, not
  // treated as absent.
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

  // A headless run is unattended, so the stop condition that halts a model
  // burning its step ceiling on a call that never changes is always on.
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
    // The false positive the step-ceiling flag's two-part condition exists to
    // prevent: a no-progress abort ends on the same terminal finish reason,
    // and is never relabelled as a ceiling stop.
    expect(outcome[0].stats).not.toHaveProperty("stoppedAtStepLimit");
  });

  // Issue #540: the run did the work it was allowed to do, so it still
  // succeeds — the stop is recorded as a fact on the statistics, not as a
  // failure.
  it("records the step-ceiling stop on the run's stats", async () => {
    const { run, outcome } = startRecordedRun();

    const { stats } = await driveOnce({
      plan: oneStepPlanOf(stuckStreamingModel()),
      run,
      prompt: "hi",
    });

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

  // The ambient causation chain a headless run establishes reaches its tools:
  // the chain is what an Event Trigger's loop guard reads (ADR-0022, #668).
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

    // readUIMessageStream re-emits the message as its parts accumulate, so a
    // single answer lands as several progressive snapshots.
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

  it("finishes as cancelled when the run is stopped mid-stream", async () => {
    const { run, outcome } = startRecordedRun();
    const drive = driveDelegate({
      plan: planOf(modelOf(text("t1", "gone in a flash"))),
      run,
      prompt: "hi",
      agentId: "sub-1",
    });
    // Stopped before it is consumed: the model stream still completes, and the
    // signal is the only record that the run was cancelled rather than finished.
    runRegistry.cancel(run.handle.runId);
    for await (const _ of drive.snapshots) void _;

    const result = await drive.done;
    // Reported, not re-derived: the delegate tool logs a cancellation
    // differently from a fault and reads the status from here to tell them
    // apart.
    expect(result.status).toBe("cancelled");
    expect(result.failure).toMatch(/Stopped before finishing/);
    expect(outcome[0].status).toBe("cancelled");
  });

  // Issue #496: a delegated run is unattended, so it drives under the same
  // no-progress stop condition a Trigger run has.
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
    // Its stop condition trips below the ceiling, and on a low ceiling could
    // trip on the ceiling step itself, so the teardown defers to it either way.
    expect(result.stoppedAtStepLimit).toBe(false);
    expect(outcome[0].stats).not.toHaveProperty("stoppedAtStepLimit");
  });

  // Issue #540. The delegate's parent has to tell a stopped delegation from a
  // finished one, so the outcome reports the stop alongside the stats.
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

  // A run that both timed out and reported a stream error is better explained
  // by the error: the parent Agent is told what broke, while the run itself
  // still records the `TimeoutError` naming the bound that was exceeded.
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

  // A delegate chains beneath its parent's ambient causation, so a write it
  // makes carries every Agent above it too (ADR-0022, #668).
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
  // A delegate's tool setup throwing: no drive ever started, but the run
  // still ends under the rule a drive would have applied.
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

  // The interactive counterpart of the delegate rule above: a Chat turn renders
  // a stream error inline (it is already in the folded message the client is
  // watching), so the run itself is not failed and the caller is told nothing
  // to throw on.
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

  // The regression from issue #552. An abort closes the SDK's stream rather
  // than failing it, so `onError` never fires and the client's branch used to
  // end clean: the answer stopped mid-word and the composer simply reset, with
  // nothing anywhere saying a bound had been hit.
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
    // The partial answer is still delivered — the notice is appended to it,
    // not substituted for it.
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

  // A user who pressed stop knows why it stopped. Telling them again would
  // dress their own action up as a failure.
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
    // Stopped once the answer has started streaming, as a user pressing stop
    // would.
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

  // Issue #540. A Chat turn's record of the stop is the message metadata: Chat
  // rows persist the message array wholesale, so that is what survives a reload
  // and what the notice renders from when the Chat is re-opened later.
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

  // An interactive Chat turn with an Agent establishes that Agent's causation
  // chain for its tools (ADR-0022, #668).
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

/** Drain a UI message stream branch into an array of its chunks. */
const collect = async <T>(stream: ReadableStream<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<T>) {
    out.push(chunk);
  }
  return out;
};

/**
 * A model that streams a partial answer and then goes quiet until the run is
 * aborted — a provider that stalls mid-answer, which is the shape both
 * timeouts exist to catch.
 */
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

/** A model that emits some text and then an error part mid-stream. */
function errorAfterText(message: string) {
  return new MockLanguageModelV3({
    doStream: () =>
      Promise.resolve({
        stream: simulateReadableStream({ chunks: errorParts(message) }),
      }),
  });
}

/**
 * The same error, on a stream that stays open until the run is aborted — so
 * the run is still in flight when its per-run timeout fires, and the drive
 * settles with both a stream error and a `TimeoutError` on the table. The race
 * is real but narrow in production; pinning it here makes the precedence
 * between the two explicit rather than incidental.
 */
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

/**
 * Tool-result clearing (ADR-0018 Notes, issue #524) is wired in once at
 * `buildModelInvocation`, which every drive shape shares — this locks that
 * every one of the three actually inherits it, at the level closest to the
 * wire: what the model call itself receives.
 */
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
          output: { type: "text" as const, value: `page ${i} content` },
        },
      ],
    }));

  const clearingPlanOf = (model: MockLanguageModelV3) => ({
    model,
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
/**
 * The headless drive's Run timeline (#647, ADR-0023). Driven with a real SDK
 * pipeline and a mock model, the way the terminal-status tests above are: what
 * the recorder receives is decided by which stream chunks the drive feeds it,
 * and that is the drive's contract.
 */
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

  /** Reasoning, then one tool call; then a text answer. */
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
      ["tool-call", "lookup", "completed"],
      ["text", null, "completed"],
    ]);
    for (const event of events.events) {
      expect(event.startedAt).toBeGreaterThan(0);
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(events.events[1].durationMs).toBeGreaterThanOrEqual(15);
  });

  it("stores no tool input, tool output, reasoning or message content", async () => {
    const { run } = startRecordedRun();
    const events = new RunEventRecorder({ runId: run.handle.runId });

    await driveOnce({
      plan: {
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
    // Each started before the other ended: the SDK runs a step's tool calls
    // concurrently, and the timeline has to say so.
    expect(a.startedAt).toBeLessThan(b.startedAt + b.durationMs!);
    expect(b.startedAt).toBeLessThan(a.startedAt + a.durationMs!);
  });

  it("records a failed tool call as an error status carrying the error", async () => {
    const { run } = startRecordedRun();
    const events = new RunEventRecorder({ runId: run.handle.runId });

    await driveOnce({
      plan: {
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

  // Under `generateText` a mid-stream provider error rejected the call. Under
  // `streamText` it arrives as an error part and the stream ends normally, so
  // the drive has to read it and fail the run itself.
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
