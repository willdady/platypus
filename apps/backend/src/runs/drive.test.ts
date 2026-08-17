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
});

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
