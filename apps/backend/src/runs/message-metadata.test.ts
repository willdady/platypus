import { describe, it, expect, vi } from "vitest";
import {
  isToolUIPart,
  readUIMessageStream,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { createMessageMetadata } from "./message-metadata.ts";
import type { PlatypusUIMessage } from "../types.ts";

/**
 * Context occupancy, driven through a real multi-step stream.
 *
 * The run-lifecycle suite mocks the AI SDK wholesale: the model is a sentinel
 * and the usage numbers are whatever the test author typed, so an
 * implementation reading the SDK's cumulative usage passes it happily. This
 * suite is the only one that can fail on ADR-0018's central trap — three
 * numbers look like occupancy and two of them are sums.
 *
 * Per-step usage is deliberately different, and deliberately not a multiple of
 * itself, so the last step's count, the sum, and any average are three
 * distinguishable numbers.
 */

const usage = (inputTotal: number, outputTotal: number) => ({
  inputTokens: {
    total: inputTotal,
    noCache: inputTotal,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
});

/** A Provider that reports an input count and no output one. */
const inputOnlyUsage = (inputTotal: number) => ({
  inputTokens: {
    total: inputTotal,
    noCache: inputTotal,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
});

/** A Provider that reports no token usage — occupancy is then unknowable. */
const NO_USAGE = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/** The tool the model calls to force a second round trip. */
const ping = tool({
  description: "Ping a service.",
  inputSchema: z.object({}),
  execute: () => Promise.resolve("pong"),
});

/**
 * The provider-level stream result and part types, reached through the mock
 * model's own signature — `@ai-sdk/provider`, which declares them, is a
 * transitive dependency rather than one this app imports directly.
 */
type StreamResult = Extract<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>["doStream"],
  ReadonlyArray<unknown>
>[number];
type StreamPart = StreamResult extends { stream: ReadableStream<infer Part> }
  ? Part
  : never;
/** What a Provider reports for one model call. */
type ProviderUsage = Extract<StreamPart, { type: "finish" }>["usage"];

const chunks = (parts: StreamPart[]): StreamResult => ({
  stream: simulateReadableStream({ chunks: parts }),
});

/** Step one: the model calls the tool. */
const toolCallStep = (reported: ProviderUsage) =>
  chunks([
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: "call-1", toolName: "ping" },
    { type: "tool-input-delta", id: "call-1", delta: "{}" },
    { type: "tool-input-end", id: "call-1" },
    { type: "tool-call", toolCallId: "call-1", toolName: "ping", input: "{}" },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_use" },
      usage: reported,
    },
  ]);

/** Step two: the tool result is back in the prompt, and the model answers. */
const answerStep = (reported: ProviderUsage) =>
  chunks([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "The service answered." },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: reported,
    },
  ]);

const mockModel = (steps: StreamResult[]) =>
  new MockLanguageModelV4({
    provider: "anthropic",
    modelId: "claude-opus-4-5",
    doStream: steps,
  });

/**
 * Consume a UI message stream the way both the client and the run's own
 * snapshot reader do, and return the message they end up with — metadata
 * chunks merged, which is where a reading either survives or is overwritten.
 */
const lastSnapshot = async (
  stream: Parameters<
    typeof readUIMessageStream<PlatypusUIMessage>
  >[0]["stream"],
): Promise<PlatypusUIMessage | undefined> => {
  let message: PlatypusUIMessage | undefined;
  for await (const snapshot of readUIMessageStream<PlatypusUIMessage>({
    stream,
  })) {
    message = snapshot;
  }
  return message;
};

/** The production wiring: the runner passes exactly this to the SDK. */
const uiStreamOf = (result: {
  toUIMessageStream: (opts: {
    messageMetadata: ReturnType<typeof createMessageMetadata>;
  }) => Parameters<typeof lastSnapshot>[0];
}) =>
  result.toUIMessageStream({
    messageMetadata: createMessageMetadata({ agentId: "agent-1" }),
  });

/**
 * A two-step turn: 1,000 tokens in on the first call, 4,200 on the second
 * because the tool call and its result are now part of the prompt. Returns the
 * finished message alongside the SDK's own cumulative figure, so a test can
 * name the number occupancy must not be.
 */
const runTurn = async () => {
  const result = streamText({
    model: mockModel([
      toolCallStep(usage(1_000, 30)),
      answerStep(usage(4_200, 70)),
    ]),
    prompt: "Ping the service and tell me what it said.",
    tools: { ping },
    stopWhen: [stepCountIs(5)],
  });

  const message = await lastSnapshot(uiStreamOf(result));
  return { message, totalUsage: await result.totalUsage };
};

describe("Context occupancy over a real multi-step stream", () => {
  it("records the last model call's input tokens, not the sum across steps", async () => {
    const { message, totalUsage } = await runTurn();

    expect(message?.metadata?.contextOccupancy).toEqual({
      inputTokens: 4_200,
      outputTokens: 70,
    });
    // The number the implementation must not have read. It is the SDK's
    // cumulative usage — correct as a billing figure, and on a twenty-step
    // turn it reads roughly an order of magnitude high.
    expect(totalUsage.inputTokens).toBe(5_200);
  });

  it("keeps the agent attribution on the same message", async () => {
    const { message } = await runTurn();

    expect(message?.metadata?.agentId).toBe("agent-1");
  });

  // A cancelled turn never emits a terminal finish part, and cancelling a long
  // turn is exactly when the context had grown most.
  it("keeps the reading from a turn cancelled mid-stream", async () => {
    const controller = new AbortController();
    const result = streamText({
      model: mockModel([
        toolCallStep(usage(1_000, 30)),
        answerStep(usage(4_200, 70)),
      ]),
      prompt: "Ping the service and tell me what it said.",
      tools: { ping },
      stopWhen: [stepCountIs(5)],
      abortSignal: controller.signal,
      // Cancelled the moment the first step lands, so the turn ends with one
      // step's reading taken and no terminal finish part.
      onStepFinish: () => controller.abort(),
    });

    const message = await lastSnapshot(uiStreamOf(result));

    // The turn really did stop early: the second step's answer never arrived.
    expect(message?.parts).not.toContainEqual(
      expect.objectContaining({ type: "text" }),
    );
    expect(message?.metadata?.contextOccupancy).toEqual({
      inputTokens: 1_000,
      outputTokens: 30,
    });
  });

  it("records nothing when the Provider reports no usage at all", async () => {
    const result = streamText({
      model: mockModel([answerStep(NO_USAGE)]),
      prompt: "Hi.",
    });

    const message = await lastSnapshot(uiStreamOf(result));

    // Attributed, but nothing estimated from the text it produced.
    expect(message?.metadata?.agentId).toBe("agent-1");
    expect(message?.metadata).not.toHaveProperty("contextOccupancy");
  });

  // The first step's 1,000 tokens are not this turn's context size, and the
  // merge would keep them on the message unless something concrete replaces
  // them.
  it("does not leave an earlier step's figure standing when the last step reports no usage", async () => {
    const result = streamText({
      model: mockModel([toolCallStep(usage(1_000, 30)), answerStep(NO_USAGE)]),
      prompt: "Ping the service and tell me what it said.",
      tools: { ping },
      stopWhen: [stepCountIs(5)],
    });

    const message = await lastSnapshot(uiStreamOf(result));

    expect(message?.metadata?.contextOccupancy).toBeNull();
  });

  // The same hazard one level down, and the merge is deep: an omitted output
  // count would pair the last step's 4,200 with the first step's 30.
  it("does not leave an earlier step's output count standing beside a fresh input count", async () => {
    const result = streamText({
      model: mockModel([
        toolCallStep(usage(1_000, 30)),
        answerStep(inputOnlyUsage(4_200)),
      ]),
      prompt: "Ping the service and tell me what it said.",
      tools: { ping },
      stopWhen: [stepCountIs(5)],
    });

    const message = await lastSnapshot(uiStreamOf(result));

    expect(message?.metadata?.contextOccupancy).toEqual({
      inputTokens: 4_200,
      outputTokens: null,
    });
  });
});

/**
 * Tool durations over a real stream.
 *
 * The point of driving the real SDK here is that the mechanism this feature
 * depends on is entirely the SDK's. `applyToolDurations` stamps the figure onto
 * the tool part, but the stream's tool reducer rebuilds that part from its
 * stored invocation and discards the stamp — so a unit test of the stamp passes
 * while the browser shows nothing (issue #353). Only a real stream can tell the
 * two apart, and these tests assert on the message a client actually reduces.
 */
describe("tool durations over a real multi-step stream", () => {
  /** Takes long enough that a rounded millisecond figure is non-zero. */
  const slowPing = tool({
    description: "Ping a service.",
    inputSchema: z.object({}),
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "pong";
    },
  });

  /** Runs a two-step turn, wiring the durations exactly as the runner does. */
  const runToolTurn = async (tools: Record<string, typeof slowPing>) => {
    const toolDurations = new Map<string, number>();
    const result = streamText({
      model: mockModel([
        toolCallStep(usage(1_000, 30)),
        answerStep(usage(4_200, 70)),
      ]),
      prompt: "Ping the service and tell me what it said.",
      tools,
      stopWhen: [stepCountIs(5)],
      onToolExecutionEnd: ({ toolCall, toolExecutionMs }) => {
        toolDurations.set(toolCall.toolCallId, toolExecutionMs);
      },
    });

    const message = await lastSnapshot(
      result.toUIMessageStream({
        messageMetadata: createMessageMetadata({
          agentId: "agent-1",
          toolDurations,
        }),
      }),
    );
    return { message, toolDurations };
  };

  it("delivers the executed tool's duration on the reduced message", async () => {
    const { message } = await runToolTurn({ ping: slowPing });

    const delivered = message?.metadata?.toolDurations?.["call-1"];
    expect(typeof delivered).toBe("number");
    expect(delivered).toBeGreaterThanOrEqual(15);
  });

  // The reason the duration travels as message metadata at all: the SDK gives
  // the tool part back without it, so this asserts the gap the metadata fills.
  // If a future SDK starts honouring the output chunk's `toolMetadata`, this
  // test failing is the signal that the metadata channel is now redundant.
  it("confirms the SDK leaves the tool part itself without a duration", async () => {
    const { message } = await runToolTurn({ ping: slowPing });

    const toolPart = message?.parts.find((part) => isToolUIPart(part));
    expect(toolPart).toBeDefined();
    expect(
      (toolPart as { toolMetadata?: Record<string, unknown> }).toolMetadata
        ?.durationMs,
    ).toBeUndefined();
  });

  it("agrees with the figure the SDK measured", async () => {
    const { message, toolDurations } = await runToolTurn({ ping: slowPing });

    expect(message?.metadata?.toolDurations?.["call-1"]).toBe(
      Math.round(toolDurations.get("call-1")!),
    );
  });

  it("records no durations for a turn that ran no tools", async () => {
    const result = streamText({
      model: mockModel([answerStep(usage(1_000, 30))]),
      prompt: "Just answer.",
      stopWhen: [stepCountIs(5)],
    });

    const message = await lastSnapshot(
      result.toUIMessageStream({
        messageMetadata: createMessageMetadata({ agentId: "agent-1" }),
      }),
    );

    expect(message?.metadata?.toolDurations).toBeUndefined();
  });
});

/**
 * The search-was-unavailable flag (issue #522).
 *
 * Driven through a real stream for one reason the unit shape cannot show: the
 * fact is emitted on `start`, and `start` is the only part guaranteed to have
 * been sent by the time a turn is cancelled. A `finish`-derived flag would be
 * absent on exactly the turns a reader most needs it on.
 */
describe("search availability over a real stream", () => {
  const answerOnly = () =>
    streamText({
      model: mockModel([answerStep(usage(1_000, 30))]),
      prompt: "What happened today?",
    });

  it("marks the reply when the turn served no search tools", async () => {
    const message = await lastSnapshot(
      answerOnly().toUIMessageStream({
        messageMetadata: createMessageMetadata({
          agentId: "agent-1",
          searchUnavailable: true,
        }),
      }),
    );

    expect(message?.metadata?.searchUnavailable).toBe(true);
  });

  it("keeps the agent attribution on the same message", async () => {
    const message = await lastSnapshot(
      answerOnly().toUIMessageStream({
        messageMetadata: createMessageMetadata({
          agentId: "agent-1",
          searchUnavailable: true,
        }),
      }),
    );

    expect(message?.metadata?.agentId).toBe("agent-1");
    expect(message?.metadata?.searchUnavailable).toBe(true);
  });

  // A key that does not apply is absent rather than `false` — the metadata
  // convention `ChatMessageMetadata` states, and what the Chat's render guard
  // relies on.
  it("says nothing about search on a turn that had it", async () => {
    const message = await lastSnapshot(
      answerOnly().toUIMessageStream({
        messageMetadata: createMessageMetadata({
          agentId: "agent-1",
          searchUnavailable: false,
        }),
      }),
    );

    expect(message?.metadata).not.toHaveProperty("searchUnavailable");
  });

  it("marks a turn with no resolved agent, which carries no other metadata", async () => {
    const message = await lastSnapshot(
      answerOnly().toUIMessageStream({
        messageMetadata: createMessageMetadata({ searchUnavailable: true }),
      }),
    );

    expect(message?.metadata?.searchUnavailable).toBe(true);
    expect(message?.metadata).not.toHaveProperty("agentId");
  });

  // The reason it rides `start`: no `finish` part is ever emitted here, and a
  // turn cancelled halfway still ran without the search it was promised.
  it("marks a turn cancelled mid-stream", async () => {
    const controller = new AbortController();
    const result = streamText({
      model: mockModel([
        toolCallStep(usage(1_000, 30)),
        answerStep(usage(4_200, 70)),
      ]),
      prompt: "Ping the service and tell me what it said.",
      tools: { ping },
      stopWhen: [stepCountIs(5)],
      abortSignal: controller.signal,
      onStepFinish: () => controller.abort(),
    });

    const message = await lastSnapshot(
      result.toUIMessageStream({
        messageMetadata: createMessageMetadata({
          agentId: "agent-1",
          searchUnavailable: true,
        }),
      }),
    );

    expect(message?.parts).not.toContainEqual(
      expect.objectContaining({ type: "text" }),
    );
    expect(message?.metadata?.searchUnavailable).toBe(true);
  });
});
