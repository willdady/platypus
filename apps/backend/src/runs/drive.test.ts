import { describe, it, expect, beforeEach } from "vitest";
import type {
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { startRun } from "./run-lifecycle.ts";
import { runRegistry } from "./run-registry.ts";
import { driveOnce, driveStreamed } from "./drive.ts";
import type { RunStatus } from "./types.ts";

/**
 * The drive is the seam that owns the model drill and the terminal decision.
 * These tests drive it with a *real* AI SDK pipeline and a mock model — no
 * `AgentRunner`, no delegate tool — to lock the unit: how a run ends
 * (succeeded / failed / cancelled), when the output-ceiling cutoff is
 * recorded, and how a streamed run reports its outcome. The `AgentRunner` and
 * sub-agent suites cover the wiring on top; this is the rule's floor.
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
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
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

/** A run observed only by recording how it ended. */
const startRecordedRun = () => {
  const outcome: Array<{ status: RunStatus; error?: Error; stats: unknown }> =
    [];
  const run = startRun({
    runId: `drive-${Math.random().toString(36).slice(2)}`,
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
      unattended: true,
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
        generatingModel({ finishReason: { unified: "length", raw: "max_tokens" } }),
      ),
      prompt: "hi",
      run,
      unattended: true,
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
      driveOnce({ plan: planOf(model), run, prompt: "hi", unattended: true }),
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

    const inflight = driveOnce({
      plan: planOf(model),
      run,
      prompt: "hi",
      unattended: true,
    });
    await new Promise((r) => setTimeout(r, 0));
    runRegistry.cancel(run.handle.runId);

    await expect(inflight).rejects.toThrow();
    expect(outcome[0].status).toBe("cancelled");
  });
});

describe("driveStreamed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("consumes the stream, keeps the latest message and finishes succeeded", async () => {
    const { run, outcome } = startRecordedRun();
    const drive = driveStreamed({
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
    const drive = driveStreamed({
      plan: planOf(model),
      run,
      prompt: "hi",
    });
    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;

    expect(result.truncated).toBe(true);
    expect(outcome[0].stats).toMatchObject({ truncatedByTokenLimit: true });
  });

  it("fails the run and reports the failure when a fail-on-error drive hits a stream error", async () => {
    const { run, outcome } = startRecordedRun();
    const model = new MockLanguageModelV3({
      doStream: () =>
        Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "I'll try" },
              { type: "text-end", id: "t1" },
              { type: "error", error: new Error("upstream reset") },
            ],
          }),
        }),
    });
    const drive = driveStreamed({
      plan: planOf(model),
      run,
      prompt: "hi",
      failOnStreamError: true,
      unattended: true,
    });
    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;

    expect(result.failure).toMatch(/upstream reset/);
    expect(outcome[0].status).toBe("failed");
  });

  it("finishes as cancelled when the run is stopped mid-stream", async () => {
    const { run, outcome } = startRecordedRun();
const drive = driveStreamed({
      plan: planOf(modelOf(text("t1", "gone in a flash"))),
      run,
      prompt: "hi",
    });
    // Stopped before it is consumed: the model stream still completes, and the
    // signal is the only record that the run was cancelled rather than finished.
    runRegistry.cancel(run.handle.runId);
    for await (const _ of drive.snapshots) void _;

    const result = await drive.done;
    expect(result.failure).toBeUndefined();
    expect(outcome[0].status).toBe("cancelled");
  });
});