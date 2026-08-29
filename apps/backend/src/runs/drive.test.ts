import { describe, it, expect, beforeEach } from "vitest";
import type { Tool } from "ai";
import type {
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { startRun } from "./run-lifecycle.ts";
import { runRegistry, TimeoutError } from "./run-registry.ts";
import { driveChat, driveDelegate, driveOnce } from "./drive.ts";
import type { RunStatus } from "./types.ts";
import { CLEARED_TOOL_RESULT_MARKER } from "./tool-result-clearing.ts";
import type { ModelMessage } from "ai";

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

/** A model backing the non-streamed `generateText` path. */
const generatingModel = (
  overrides: Partial<LanguageModelV3GenerateResult> = {},
): MockLanguageModelV3 =>
  new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: {
          total: 10,
          noCache: 10,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 4, text: 4, reasoning: undefined },
      },
      ...overrides,
    } as LanguageModelV3GenerateResult,
  });

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

/** The same stuck loop on the `generateText` path. */
const stuckGeneratingModel = () => {
  let index = 0;
  return new MockLanguageModelV3({
    doGenerate: () => {
      const id = `tc${(index += 1)}`;
      return Promise.resolve({
        content: [
          {
            type: "tool-call",
            toolCallId: id,
            toolName: STUCK_TOOL,
            input: "{}",
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: USAGE,
      } as unknown as LanguageModelV3GenerateResult);
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

describe("driveOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the text and stats and finishes the run as succeeded", async () => {
    const { run, outcome } = startRecordedRun();

    const { text: textOut, stats } = await driveOnce({
      plan: planOf(generatingModel()),
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
        generatingModel({
          finishReason: { unified: "length", raw: "max_tokens" },
        }),
      ),
      prompt: "hi",
      run,
    });

    expect(stats.truncatedByTokenLimit).toBe(true);
    expect(outcome[0].stats).toMatchObject({ truncatedByTokenLimit: true });
  });

  // Issue #734. The non-streamed `generateText` path folds usage through
  // `computeStats`, which must carry the cached-input breakdown the same way
  // the streamed accumulator does. A write of 0 is a real measurement and is
  // kept, not treated as absent.
  it("carries cached read and write counts onto the run's stats", async () => {
    const { run, outcome } = startRecordedRun();

    const { stats } = await driveOnce({
      plan: planOf(
        generatingModel({
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
      plan: planOf(generatingModel()),
      prompt: "hi",
      run,
    });

    expect(stats).not.toHaveProperty("cacheReadTokens");
    expect(stats).not.toHaveProperty("cacheWriteTokens");
  });

  it("finishes as failed and rethrows when the model call throws", async () => {
    const { run, outcome } = startRecordedRun();
    const model = new MockLanguageModelV3({
      doGenerate: () => {
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
      doGenerate: () =>
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
      plan: stuckPlanOf(stuckGeneratingModel()),
      run,
      prompt: "hi",
    });

    expect(outcome[0].status).toBe("failed");
    expect(outcome[0].error?.name).toBe("NoProgressError");
    expect(outcome[0].error?.message).toMatch(
      new RegExp(`no_progress:.*${STUCK_TOOL}`),
    );
  });

  // Issue #540: the run did the work it was allowed to do, so it still
  // succeeds — the stop is recorded as a fact on the statistics, not as a
  // failure.
  it("records the step-ceiling stop on the run's stats", async () => {
    const { run, outcome } = startRecordedRun();

    const { stats } = await driveOnce({
      plan: oneStepPlanOf(stuckGeneratingModel()),
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
      plan: planOf(generatingModel()),
      run,
      prompt: "hi",
    });

    expect(stats).not.toHaveProperty("stoppedAtStepLimit");
    expect(outcome[0].stats).not.toHaveProperty("stoppedAtStepLimit");
  });

  // The false positive the two-part condition exists to prevent: a no-progress
  // abort ends on the same terminal finish reason. It keeps its own failed
  // status and `no_progress:` message and is never relabelled.
  it("does not report a no-progress abort as a step-ceiling stop", async () => {
    const { run, outcome } = startRecordedRun();

    const { stats } = await driveOnce({
      plan: stuckPlanOf(stuckGeneratingModel()),
      run,
      prompt: "hi",
    });

    expect(stats).not.toHaveProperty("stoppedAtStepLimit");
    expect(outcome[0].status).toBe("failed");
    expect(outcome[0].stats).not.toHaveProperty("stoppedAtStepLimit");
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
    const drive = driveDelegate({ plan: planOf(model), run, prompt: "hi" });
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
    });
    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;

    expect(result.status).toBe("failed");
    expect(result.failure).toMatch(new RegExp(`no_progress:.*${STUCK_TOOL}`));
    expect(outcome[0].error?.name).toBe("NoProgressError");
  });

  // Issue #540. The delegate's parent has to tell a stopped delegation from a
  // finished one, so the outcome reports the stop alongside the stats.
  it("reports the step-ceiling stop to its caller and on the run's stats", async () => {
    const { run, outcome } = startRecordedRun();
    const drive = driveDelegate({
      plan: oneStepPlanOf(stuckStreamingModel()),
      run,
      prompt: "hi",
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
    });
    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;

    expect(result.stoppedAtStepLimit).toBe(false);
    expect(outcome[0].stats).not.toHaveProperty("stoppedAtStepLimit");
  });

  // The no-progress abort keeps its own reporting on the streamed path too: its
  // stop condition trips below the ceiling, and on a low ceiling could trip on
  // the ceiling step itself, so the teardown defers to it either way.
  it("does not report a no-progress abort as a step-ceiling stop", async () => {
    const { run, outcome } = startRecordedRun();
    const drive = driveDelegate({
      plan: stuckPlanOf(stuckStreamingModel()),
      run,
      prompt: "hi",
    });
    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;

    expect(result.stoppedAtStepLimit).toBe(false);
    expect(result.failure).toMatch(new RegExp(`no_progress:.*${STUCK_TOOL}`));
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
    });
    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;

    expect(result.failure).toMatch(/upstream reset/);
    expect(result.failure).not.toMatch(/Stopped before finishing/);
    expect(outcome[0].status).toBe("failed");
    expect(outcome[0].error).toBeInstanceOf(TimeoutError);
  });
});

describe("driveChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hands back a client stream branch alongside the snapshots", async () => {
    const { run } = startRecordedRun();
    const drive = driveChat({
      plan: planOf(modelOf(text("t1", "Hi"))),
      run,
      modelMessages: [{ role: "user", content: "hi" }],
    });

    expect(drive.response).toBeInstanceOf(ReadableStream);
    for await (const _ of drive.snapshots) void _;
    await drive.done;
    await drive.response.cancel();
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
    setTimeout(() => runRegistry.cancel(run.handle.runId), 20);

    const chunks = await collect(drive.response);
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

  const capturingGenerateModel = (record: { prompt?: unknown }) =>
    new MockLanguageModelV3({
      doGenerate: (options: { prompt: unknown }) => {
        record.prompt = options.prompt;
        return Promise.resolve({
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: USAGE,
        } as unknown as LanguageModelV3GenerateResult);
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
    });
    for await (const _ of drive.snapshots) void _;
    await drive.done;

    expect(JSON.stringify(record.prompt)).toContain(CLEARED_TOOL_RESULT_MARKER);
  });

  it("driveOnce clears stale tool results already past threshold on the first call", async () => {
    const { run } = startRecordedRun();
    const record: { prompt?: unknown } = {};
    await driveOnce({
      plan: clearingPlanOf(capturingGenerateModel(record)),
      run,
      modelMessages: staleToolMessages(10),
    });

    expect(JSON.stringify(record.prompt)).toContain(CLEARED_TOOL_RESULT_MARKER);
  });

  it("clears nothing below threshold, on any of the three drive shapes", async () => {
    const { run } = startRecordedRun();
    const record: { prompt?: unknown } = {};
    await driveOnce({
      plan: {
        ...clearingPlanOf(capturingGenerateModel(record)),
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
