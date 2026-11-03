import { describe, expect, it } from "vitest";
import { APICallError, simulateReadableStream, type ModelMessage } from "ai";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { startRun } from "./run-lifecycle.ts";
import { RunEventRecorder } from "./run-events.ts";
import { driveDelegate, driveOnce } from "./drive.ts";
import type { RunPlan } from "./run-plan.ts";
import type { RunStatus } from "./types.ts";

const USAGE = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};

const finish = (): LanguageModelV3StreamPart => ({
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: USAGE,
});

const textModel = (text = "fallback answer") =>
  new MockLanguageModelV3({
    doStream: () =>
      Promise.resolve({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: text },
            { type: "text-end", id: "t1" },
            finish(),
          ],
        }),
      }),
  });

const apiError = (statusCode: number, message = "provider failed") =>
  new APICallError({
    message,
    url: "https://provider.example/v1/chat",
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
  });

/** A model whose every call rejects with the given error. */
const failingModel = (error: unknown, onCall?: () => void) =>
  new MockLanguageModelV3({
    doStream: () => {
      onCall?.();
      return Promise.reject(error);
    },
  });

const planOf = (
  model: MockLanguageModelV3,
  overrides: Partial<RunPlan> = {},
): RunPlan => ({
  model,
  tools: {},
  maxSteps: 3,
  ...overrides,
});

const startRecorded = (runId: string) => {
  const outcome: Array<{
    status: RunStatus;
    error?: Error;
    stats: import("./types.ts").RunStats;
  }> = [];
  const run = startRun({
    runId,
    onTerminate: ({ status, error, stats }) => {
      outcome.push({ status, error, stats });
    },
  });
  return { run, outcome };
};

const runId = () => `fallback-${Math.random().toString(36).slice(2)}`;

describe("driveOnce with a Fallback model", () => {
  it("switches on a Provider failure and finishes on the fallback", async () => {
    const id = runId();
    const { run, outcome } = startRecorded(id);
    const events = new RunEventRecorder({ runId: id });

    const { text, stats } = await driveOnce({
      plan: planOf(failingModel(apiError(503)), {
        usageModel: { providerId: "p1", model: "m1" },
      }),
      fallback: {
        plan: planOf(textModel(), {
          usageModel: { providerId: "p2", model: "m2" },
        }),
        system: "fallback prompt",
      },
      run,
      events,
      prompt: "hi",
    });

    expect(text).toBe("fallback answer");
    expect(outcome[0]?.status).toBe("succeeded");
    expect(stats.steps).toBe(1);
    expect(stats.fallback).toEqual({
      from: { providerId: "p1", model: "m1" },
      to: { providerId: "p2", model: "m2" },
    });
    // The fallback's calls are billed to the fallback.
    expect(outcome[0]?.stats.usageByModel).toEqual([
      expect.objectContaining({ providerId: "p2", model: "m2" }),
    ]);

    const switchEvent = events.events.find(
      (event) => event.type === "model-switch",
    );
    expect(switchEvent).toMatchObject({
      status: "completed",
      modelSwitch: {
        from: { providerId: "p1", model: "m1" },
        to: { providerId: "p2", model: "m2" },
      },
    });
    expect(switchEvent?.error?.message).toEqual(expect.any(String));
  });

  it("gives the primary one SDK retry, so two attempts precede the switch", async () => {
    const id = runId();
    const { run } = startRecorded(id);
    let attempts = 0;

    await driveOnce({
      plan: planOf(
        failingModel(apiError(503), () => {
          attempts += 1;
        }),
        { usageModel: { providerId: "p1", model: "m1" } },
      ),
      fallback: {
        plan: planOf(textModel(), {
          usageModel: { providerId: "p2", model: "m2" },
        }),
        system: "fallback prompt",
      },
      run,
      prompt: "hi",
    });

    expect(attempts).toBe(2);
  });

  it("never switches on a request the primary rejected as invalid", async () => {
    const id = runId();
    const { run, outcome } = startRecorded(id);

    await expect(
      driveOnce({
        plan: planOf(failingModel(apiError(400, "bad request")), {
          usageModel: { providerId: "p1", model: "m1" },
        }),
        fallback: {
          plan: planOf(textModel(), {
            usageModel: { providerId: "p2", model: "m2" },
          }),
          system: "fallback prompt",
        },
        run,
        prompt: "hi",
      }),
    ).rejects.toThrow();

    expect(outcome[0]?.status).toBe("failed");
    expect(outcome[0]?.stats.fallback).toBeUndefined();
  });

  it("names both failures when the fallback fails too", async () => {
    const id = runId();
    const { run, outcome } = startRecorded(id);

    await expect(
      driveOnce({
        plan: planOf(failingModel(apiError(503, "primary down")), {
          usageModel: { providerId: "p1", model: "m1" },
        }),
        fallback: {
          plan: planOf(failingModel(apiError(500, "fallback down")), {
            usageModel: { providerId: "p2", model: "m2" },
          }),
          system: "fallback prompt",
        },
        run,
        prompt: "hi",
      }),
    ).rejects.toThrow(/primary.*fallback/i);

    expect(outcome[0]?.status).toBe("failed");
    expect(outcome[0]?.error?.message).toMatch(/primary/i);
    expect(outcome[0]?.error?.message).toMatch(/fallback/i);
  });

  it("continues from the primary's completed tool step, stripped for the new Provider", async () => {
    const id = runId();
    const { run, outcome } = startRecorded(id);
    const seenPrompts: ModelMessage[][] = [];

    let call = 0;
    const primary = new MockLanguageModelV3({
      doStream: () => {
        call += 1;
        if (call === 1) {
          return Promise.resolve({
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "reasoning-start", id: "r1" },
                { type: "reasoning-delta", id: "r1", delta: "secret plan" },
                { type: "reasoning-end", id: "r1" },
                { type: "tool-input-start", id: "c1", toolName: "lookup" },
                { type: "tool-input-end", id: "c1" },
                {
                  type: "tool-call",
                  toolCallId: "c1",
                  toolName: "lookup",
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
        return Promise.reject(apiError(503));
      },
    });

    const fallback = new MockLanguageModelV3({
      doStream: ({ prompt }) => {
        seenPrompts.push(prompt);
        return Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t2" },
              { type: "text-delta", id: "t2", delta: "done" },
              { type: "text-end", id: "t2" },
              finish(),
            ],
          }),
        });
      },
    });

    await driveOnce({
      plan: planOf(primary, {
        usageModel: { providerId: "p1", model: "m1" },
        tools: {
          lookup: {
            inputSchema: z.object({}),
            execute: () => Promise.resolve("the lookup result"),
          },
        },
      }),
      fallback: {
        plan: planOf(fallback, {
          usageModel: { providerId: "p2", model: "m2" },
        }),
        system: "fallback prompt",
      },
      run,
      prompt: "hi",
    });

    const prompt = JSON.stringify(seenPrompts[0]);
    expect(prompt).toContain("the lookup result");
    expect(prompt).not.toContain("secret plan");

    // A mid-run switch bills both models: the primary's completed step and
    // the fallback's.
    expect(outcome[0]?.stats.usageByModel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: "p1", model: "m1" }),
        expect.objectContaining({ providerId: "p2", model: "m2" }),
      ]),
    );
  });

  it("counts the step ceiling across the switch", async () => {
    const id = runId();
    const { run } = startRecorded(id);

    let call = 0;
    const primary = new MockLanguageModelV3({
      doStream: () => {
        call += 1;
        if (call === 1) {
          return Promise.resolve({
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "tool-input-start", id: "p1", toolName: "lookup" },
                { type: "tool-input-end", id: "p1" },
                {
                  type: "tool-call",
                  toolCallId: "p1",
                  toolName: "lookup",
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
        return Promise.reject(apiError(503));
      },
    });

    let fallbackCalls = 0;
    const fallback = new MockLanguageModelV3({
      doStream: () => {
        fallbackCalls += 1;
        return Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-input-start", id: "c1", toolName: "lookup" },
              { type: "tool-input-end", id: "c1" },
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "lookup",
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

    const { stats } = await driveOnce({
      plan: planOf(primary, {
        // Two steps in total: the primary takes one, so the fallback has one.
        maxSteps: 2,
        usageModel: { providerId: "p1", model: "m1" },
        tools: {
          lookup: {
            inputSchema: z.object({}),
            execute: () => Promise.resolve("found"),
          },
        },
      }),
      fallback: {
        plan: planOf(fallback, {
          usageModel: { providerId: "p2", model: "m2" },
        }),
        system: "fallback prompt",
      },
      run,
      prompt: "hi",
    });

    expect(stats.steps).toBe(2);
    expect(fallbackCalls).toBe(1);
    expect(stats.stoppedAtStepLimit).toBe(true);
  });

  it(
    "switches a Sub-Agent run on its own fallback",
    { timeout: 15000 },
    async () => {
      const id = runId();
      const { run, outcome } = startRecorded(id);
      const events = new RunEventRecorder({ runId: id });

      const drive = driveDelegate({
        plan: planOf(failingModel(apiError(503)), {
          usageModel: { providerId: "p1", model: "m1" },
        }),
        fallback: {
          plan: planOf(textModel(), {
            usageModel: { providerId: "p2", model: "m2" },
          }),
          system: "fallback prompt",
        },
        run,
        prompt: "do the task",
        agentId: "sub-1",
        events: { recorder: events, parentEventId: null },
      });

      for await (const _message of drive.snapshots) void _message;
      const result = await drive.done;

      expect(result.status).toBe("succeeded");
      expect(outcome[0]?.stats.fallback?.to).toEqual({
        providerId: "p2",
        model: "m2",
      });
      expect(events.events.some((event) => event.type === "model-switch")).toBe(
        true,
      );
    },
  );
});
