import { describe, it, expect } from "vitest";
import {
  isToolUIPart,
  readUIMessageStream,
  simulateReadableStream,
  stepCountIs,
  streamText,
  toUIMessageStream,
  tool,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

import { createMessageMetadata } from "./message-metadata.ts";
import type { PlatypusUIMessage } from "../types.ts";

const usage = (inputTotal: number, outputTotal: number) => ({
  inputTokens: {
    total: inputTotal,
    noCache: inputTotal,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
});

const inputOnlyUsage = (inputTotal: number) => ({
  inputTokens: {
    total: inputTotal,
    noCache: inputTotal,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
});

const NO_USAGE = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

const cachedUsage = (
  inputTotal: number,
  outputTotal: number,
  cacheRead: number | undefined,
  cacheWrite: number | undefined,
) => ({
  inputTokens: {
    total: inputTotal,
    noCache: inputTotal - (cacheRead ?? 0) - (cacheWrite ?? 0) || undefined,
    cacheRead,
    cacheWrite,
  },
  outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
});

const ping = tool({
  description: "Ping a service.",
  inputSchema: z.object({}),
  execute: () => Promise.resolve("pong"),
});

type StreamResult = Extract<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>["doStream"],
  ReadonlyArray<unknown>
>[number];
type StreamPart = StreamResult extends { stream: ReadableStream<infer Part> }
  ? Part
  : never;
type ProviderUsage = Extract<StreamPart, { type: "finish" }>["usage"];

const chunks = (parts: StreamPart[]): StreamResult => ({
  stream: simulateReadableStream({ chunks: parts }),
});

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

const uiStreamOf = <TOOLS extends ToolSet>(result: {
  stream: ReadableStream<TextStreamPart<TOOLS>>;
}) =>
  toUIMessageStream({
    stream: result.stream,
    messageMetadata: createMessageMetadata({
      stepCeiling: 3,
      agentId: "agent-1",
    }),
  });

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
  return { message, totalUsage: await result.usage };
};

describe("Context occupancy over a real multi-step stream", () => {
  it("records the last model call's input tokens, not the sum across steps", async () => {
    const { message, totalUsage } = await runTurn();

    expect(message?.metadata?.contextOccupancy).toEqual({
      inputTokens: 4_200,
      outputTokens: 70,
    });
    expect(totalUsage.inputTokens).toBe(5_200);
  });

  it("keeps the agent attribution on the same message", async () => {
    const { message } = await runTurn();

    expect(message?.metadata?.agentId).toBe("agent-1");
  });

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
      onStepEnd: () => controller.abort(),
    });

    const message = await lastSnapshot(uiStreamOf(result));

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

    expect(message?.metadata?.agentId).toBe("agent-1");
    expect(message?.metadata).not.toHaveProperty("contextOccupancy");
  });

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
    expect(message?.metadata?.tokenUsage).toEqual({
      inputTokens: 5_200,
      outputTokens: 30,
    });
  });
});

describe("tool durations over a real multi-step stream", () => {
  const slowPing = tool({
    description: "Ping a service.",
    inputSchema: z.object({}),
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "pong";
    },
  });

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
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          agentId: "agent-1",
          toolDurations,
        }),
      }),
    );
    return { message, toolDurations };
  };

  it("delivers the duration the SDK measured on the reduced message", async () => {
    const { message, toolDurations } = await runToolTurn({ ping: slowPing });

    const delivered = message?.metadata?.toolDurations?.["call-1"];
    expect(delivered).toBe(Math.round(toolDurations.get("call-1")!));
    expect(delivered).toBeGreaterThanOrEqual(15);
  });

  it("confirms the SDK leaves the tool part itself without a duration", async () => {
    const { message } = await runToolTurn({ ping: slowPing });

    const toolPart = message?.parts.find((part) => isToolUIPart(part));
    expect(toolPart).toBeDefined();
    expect(
      (toolPart as { toolMetadata?: Record<string, unknown> }).toolMetadata
        ?.durationMs,
    ).toBeUndefined();
  });

  it("records no durations for a turn that ran no tools", async () => {
    const result = streamText({
      model: mockModel([answerStep(usage(1_000, 30))]),
      prompt: "Just answer.",
      stopWhen: [stepCountIs(5)],
    });

    const message = await lastSnapshot(
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          agentId: "agent-1",
        }),
      }),
    );

    expect(message?.metadata?.toolDurations).toBeUndefined();
  });
});

describe("Token usage over a real multi-step stream", () => {
  const runTokenUsageTurn = async () => {
    const result = streamText({
      model: mockModel([
        toolCallStep(usage(1_000, 30)),
        answerStep(usage(4_200, 70)),
      ]),
      prompt: "Ping the service and tell me what it said.",
      tools: { ping },
      stopWhen: [stepCountIs(5)],
    });

    return {
      message: await lastSnapshot(
        toUIMessageStream({
          stream: result.stream,
          messageMetadata: createMessageMetadata({
            stepCeiling: 3,
            agentId: "agent-1",
          }),
        }),
      ),
    };
  };

  it("folds input and output tokens across every step, not the last one", async () => {
    const { message } = await runTokenUsageTurn();

    expect(message?.metadata?.tokenUsage).toEqual({
      inputTokens: 5_200,
      outputTokens: 100,
    });
  });

  it("adds the usage the turn's delegates reported", async () => {
    const result = streamText({
      model: mockModel([
        toolCallStep(usage(1_000, 30)),
        answerStep(usage(4_200, 70)),
      ]),
      prompt: "Ping the service and tell me what it said.",
      tools: { ping },
      stopWhen: [stepCountIs(5)],
    });

    const message = await lastSnapshot(
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          delegatedUsage: () => [
            {
              providerId: "p",
              model: "m",
              inputTokens: 300,
              outputTokens: 20,
              cacheReadTokens: 100,
            },
          ],
        }),
      }),
    );

    expect(message?.metadata?.tokenUsage).toEqual({
      inputTokens: 5_500,
      outputTokens: 120,
      cacheReadTokens: 100,
    });
    expect(message?.metadata?.contextOccupancy).toEqual({
      inputTokens: 4_200,
      outputTokens: 70,
    });
  });

  it("adds onto what a continued reply already recorded", async () => {
    const result = streamText({
      model: mockModel([answerStep(usage(4_200, 70))]),
      prompt: "Carry on.",
    });
    let clock = 1_000;

    const message = await lastSnapshot(
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          prepDurationMs: 40,
          driveStartMs: 1_000,
          now: () => (clock += 500),
          continued: {
            tokenUsage: { inputTokens: 1_000, outputTokens: 30 },
            modelDurationMs: 2_000,
            prepDurationMs: 60,
          },
        }),
      }),
    );

    expect(message?.metadata?.tokenUsage).toEqual({
      inputTokens: 5_200,
      outputTokens: 100,
    });
    expect(message?.metadata?.modelDurationMs).toBe(2_500);
    expect(message?.metadata?.prepDurationMs).toBe(100);
  });

  it("keeps the folded sum from a turn cancelled mid-stream", async () => {
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
      onStepEnd: () => controller.abort(),
    });

    const message = await lastSnapshot(
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          agentId: "agent-1",
        }),
      }),
    );

    expect(message?.metadata?.tokenUsage).toEqual({
      inputTokens: 1_000,
      outputTokens: 30,
    });
  });

  it("records no Token usage when the Provider reports none at all", async () => {
    const result = streamText({
      model: mockModel([answerStep(NO_USAGE)]),
      prompt: "Hi.",
    });

    const message = await lastSnapshot(
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          agentId: "agent-1",
        }),
      }),
    );

    expect(message?.metadata).not.toHaveProperty("tokenUsage");
  });

  const runWithUsages = async (first: ProviderUsage, second: ProviderUsage) => {
    const result = streamText({
      model: mockModel([toolCallStep(first), answerStep(second)]),
      prompt: "Ping the service and tell me what it said.",
      tools: { ping },
      stopWhen: [stepCountIs(5)],
    });

    return lastSnapshot(
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          agentId: "agent-1",
        }),
      }),
    );
  };

  it("folds cached-read and cached-write tokens across every step (Anthropic/Bedrock shape)", async () => {
    const message = await runWithUsages(
      cachedUsage(1_000, 30, 700, 100),
      cachedUsage(4_200, 70, 2_000, 50),
    );

    expect(message?.metadata?.tokenUsage).toEqual({
      inputTokens: 5_200,
      outputTokens: 100,
      cacheReadTokens: 2_700,
      cacheWriteTokens: 150,
    });
  });

  it("reports a cached-read count without a write one (OpenAI/Google shape)", async () => {
    const message = await runWithUsages(
      cachedUsage(1_000, 30, 500, undefined),
      cachedUsage(4_200, 70, 900, undefined),
    );

    expect(message?.metadata?.tokenUsage).toEqual({
      inputTokens: 5_200,
      outputTokens: 100,
      cacheReadTokens: 1_400,
    });
  });

  it("keeps Input, Output and Total unchanged when a Provider reports cache details", async () => {
    const message = await runWithUsages(
      cachedUsage(1_000, 30, 700, 100),
      cachedUsage(4_200, 70, 2_000, 50),
    );

    expect(message?.metadata?.tokenUsage?.inputTokens).toBe(5_200);
    expect(message?.metadata?.tokenUsage?.outputTokens).toBe(100);
  });

  it("persists no cache keys for a Provider that reports no cache detail", async () => {
    const message = await runWithUsages(usage(1_000, 30), usage(4_200, 70));

    expect(message?.metadata?.tokenUsage).toEqual({
      inputTokens: 5_200,
      outputTokens: 100,
    });
  });

  it("sums the cached counts across steps, never replacing an earlier step's", async () => {
    const message = await runWithUsages(
      cachedUsage(1_000, 30, 700, 100),
      cachedUsage(4_200, 70, 2_000, undefined),
    );

    expect(message?.metadata?.tokenUsage).toEqual({
      inputTokens: 5_200,
      outputTokens: 100,
      cacheReadTokens: 2_700,
      cacheWriteTokens: 100,
    });
  });
});

describe("Preparation and Model durations", () => {
  const answerOnly = () =>
    streamText({
      model: mockModel([answerStep(usage(1_000, 30))]),
      prompt: "Hi.",
    });

  it("stamps Preparation on `start`, known before the model was ever called", async () => {
    const message = await lastSnapshot(
      toUIMessageStream({
        stream: answerOnly().stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          agentId: "agent-1",
          prepDurationMs: 842,
        }),
      }),
    );

    expect(message?.metadata?.prepDurationMs).toBe(842);
  });

  it("says nothing about Preparation when the drive never measured one", async () => {
    const message = await lastSnapshot(
      toUIMessageStream({
        stream: answerOnly().stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          agentId: "agent-1",
        }),
      }),
    );

    expect(message?.metadata).not.toHaveProperty("prepDurationMs");
  });

  it("computes Model duration as the elapsed time since the Drive started, last step standing", async () => {
    let calls = 0;
    const now = () => 1_000 + calls++ * 500;

    const result = streamText({
      model: mockModel([
        toolCallStep(usage(1_000, 30)),
        answerStep(usage(4_200, 70)),
      ]),
      prompt: "Ping the service and tell me what it said.",
      tools: { ping },
      stopWhen: [stepCountIs(5)],
    });

    const message = await lastSnapshot(
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          agentId: "agent-1",
          driveStartMs: 1_000,
          now,
        }),
      }),
    );

    expect(message?.metadata?.modelDurationMs).toBe(500);
  });

  it("keeps the last Model duration reading from a turn cancelled mid-stream", async () => {
    const controller = new AbortController();
    let calls = 0;
    const now = () => 1_000 + calls++ * 500;

    const result = streamText({
      model: mockModel([
        toolCallStep(usage(1_000, 30)),
        answerStep(usage(4_200, 70)),
      ]),
      prompt: "Ping the service and tell me what it said.",
      tools: { ping },
      stopWhen: [stepCountIs(5)],
      abortSignal: controller.signal,
      onStepEnd: () => controller.abort(),
    });

    const message = await lastSnapshot(
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          agentId: "agent-1",
          driveStartMs: 1_000,
          now,
        }),
      }),
    );

    expect(message?.parts).not.toContainEqual(
      expect.objectContaining({ type: "text" }),
    );
    expect(message?.metadata?.modelDurationMs).toBe(0);
  });

  it("says nothing about Model duration when the drive never measured a start", async () => {
    const message = await lastSnapshot(
      toUIMessageStream({
        stream: answerOnly().stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          agentId: "agent-1",
        }),
      }),
    );

    expect(message?.metadata).not.toHaveProperty("modelDurationMs");
  });
});

describe("read-only Tool names over a real multi-step stream", () => {
  it("reports a called tool the resolver says is clearable", async () => {
    const result = streamText({
      model: mockModel([
        toolCallStep(usage(1_000, 30)),
        answerStep(usage(4_200, 70)),
      ]),
      prompt: "Ping the service and tell me what it said.",
      tools: { ping },
      stopWhen: [stepCountIs(5)],
    });

    const message = await lastSnapshot(
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          agentId: "agent-1",
          isClearableTool: (name) => name === "ping",
        }),
      }),
    );

    expect(message?.metadata?.readOnlyToolNames).toEqual(["ping"]);
  });

  it("reports nothing when the resolver says no called tool is clearable", async () => {
    const result = streamText({
      model: mockModel([
        toolCallStep(usage(1_000, 30)),
        answerStep(usage(4_200, 70)),
      ]),
      prompt: "Ping the service and tell me what it said.",
      tools: { ping },
      stopWhen: [stepCountIs(5)],
    });

    const message = await lastSnapshot(
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          agentId: "agent-1",
          isClearableTool: () => false,
        }),
      }),
    );

    expect(message?.metadata).not.toHaveProperty("readOnlyToolNames");
  });

  it("reports nothing when no resolver is given at all", async () => {
    const { message } = await runTurn();

    expect(message?.metadata).not.toHaveProperty("readOnlyToolNames");
  });

  it("reports nothing for a turn that called no tools", async () => {
    const result = streamText({
      model: mockModel([answerStep(usage(1_000, 30))]),
      prompt: "Just answer.",
    });

    const message = await lastSnapshot(
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          agentId: "agent-1",
          isClearableTool: () => true,
        }),
      }),
    );

    expect(message?.metadata).not.toHaveProperty("readOnlyToolNames");
  });

  it("keeps every called tool's name and duration across steps, not only the last", async () => {
    const toolDurations = new Map<string, number>();
    const result = streamText({
      model: mockModel([
        toolCallStep(usage(1_000, 30)),
        chunks([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "call-2",
            toolName: "echo",
            input: "{}",
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: usage(2_000, 30),
          },
        ]),
        answerStep(usage(4_200, 70)),
      ]),
      prompt: "Ping the service, then echo.",
      tools: { ping, echo: ping },
      stopWhen: [stepCountIs(5)],
      onToolExecutionEnd: ({ toolCall, toolExecutionMs }) => {
        toolDurations.set(toolCall.toolCallId, toolExecutionMs);
      },
    });

    const message = await lastSnapshot(
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 5,
          toolDurations,
          isClearableTool: () => true,
        }),
      }),
    );

    expect(message?.metadata?.readOnlyToolNames).toEqual(["ping", "echo"]);
    expect(Object.keys(message?.metadata?.toolDurations ?? {})).toEqual([
      "call-1",
      "call-2",
    ]);
  });
});

describe("search availability over a real stream", () => {
  const answerOnly = () =>
    streamText({
      model: mockModel([answerStep(usage(1_000, 30))]),
      prompt: "What happened today?",
    });

  it("marks the reply when the turn served no search tools", async () => {
    const message = await lastSnapshot(
      toUIMessageStream({
        stream: answerOnly().stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          agentId: "agent-1",
          searchUnavailable: true,
        }),
      }),
    );

    expect(message?.metadata?.searchUnavailable).toBe(true);
  });

  it("keeps the agent attribution on the same message", async () => {
    const message = await lastSnapshot(
      toUIMessageStream({
        stream: answerOnly().stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          agentId: "agent-1",
          searchUnavailable: true,
        }),
      }),
    );

    expect(message?.metadata?.agentId).toBe("agent-1");
    expect(message?.metadata?.searchUnavailable).toBe(true);
  });

  it("says nothing about search on a turn that had it", async () => {
    const message = await lastSnapshot(
      toUIMessageStream({
        stream: answerOnly().stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          agentId: "agent-1",
          searchUnavailable: false,
        }),
      }),
    );

    expect(message?.metadata).not.toHaveProperty("searchUnavailable");
  });

  it("marks a turn with no resolved agent, which carries no other metadata", async () => {
    const message = await lastSnapshot(
      toUIMessageStream({
        stream: answerOnly().stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
          searchUnavailable: true,
        }),
      }),
    );

    expect(message?.metadata?.searchUnavailable).toBe(true);
    expect(message?.metadata).not.toHaveProperty("agentId");
  });

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
      onStepEnd: () => controller.abort(),
    });

    const message = await lastSnapshot(
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          stepCeiling: 3,
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

describe("the step-ceiling stop over a real multi-step stream", () => {
  const haltedAtCeiling = (stepCeiling: number) => {
    const result = streamText({
      model: mockModel([
        toolCallStep(usage(1_000, 30)),
        answerStep(usage(4_200, 70)),
      ]),
      prompt: "Ping the service and tell me what it said.",
      tools: { ping },
      stopWhen: [stepCountIs(stepCeiling)],
    });
    return lastSnapshot(
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          agentId: "agent-1",
          stepCeiling,
        }),
      }),
    );
  };

  it("flags a turn whose loop was stopped with the model still asking to continue", async () => {
    const message = await haltedAtCeiling(1);

    expect(message?.metadata?.stoppedAtStepLimit).toBe(true);
  });

  it("describes a turn that really did end without an answer", async () => {
    const message = await haltedAtCeiling(1);

    expect(message?.parts).not.toContainEqual(
      expect.objectContaining({ type: "text" }),
    );
    expect(message?.metadata).not.toHaveProperty("truncatedByTokenLimit");
  });

  it("says nothing about the step limit on a turn the model finished", async () => {
    const message = await haltedAtCeiling(5);

    expect(message?.metadata).not.toHaveProperty("stoppedAtStepLimit");
  });

  it("says nothing when the last allowed step ended on a normal stop", async () => {
    const message = await haltedAtCeiling(2);

    expect(message?.parts).toContainEqual(
      expect.objectContaining({ type: "text" }),
    );
    expect(message?.metadata).not.toHaveProperty("stoppedAtStepLimit");
  });

  it("says nothing when another stop condition halted the loop below the ceiling", async () => {
    const result = streamText({
      model: mockModel([
        toolCallStep(usage(1_000, 30)),
        answerStep(usage(4_200, 70)),
      ]),
      prompt: "Ping the service and tell me what it said.",
      tools: { ping },
      stopWhen: [stepCountIs(5), () => true],
    });

    const message = await lastSnapshot(
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          agentId: "agent-1",
          stepCeiling: 5,
        }),
      }),
    );

    expect(message?.metadata).not.toHaveProperty("stoppedAtStepLimit");
  });

  it("reports the output ceiling, not the step limit, when the reply ran out of room", async () => {
    const result = streamText({
      model: mockModel([
        chunks([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "half an ans" },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "length", raw: "max_tokens" },
            usage: usage(1_000, 30),
          },
        ]),
      ]),
      prompt: "Write at length.",
      stopWhen: [stepCountIs(1)],
    });

    const message = await lastSnapshot(
      toUIMessageStream({
        stream: result.stream,
        messageMetadata: createMessageMetadata({
          agentId: "agent-1",
          stepCeiling: 1,
        }),
      }),
    );

    expect(message?.metadata?.truncatedByTokenLimit).toBe(true);
    expect(message?.metadata).not.toHaveProperty("stoppedAtStepLimit");
    expect(message?.metadata?.agentId).toBe("agent-1");
  });

  it("reports nothing when the loop stopped below the ceiling it was given", async () => {
    const result = streamText({
      model: mockModel([
        toolCallStep(usage(1_000, 30)),
        answerStep(usage(4_200, 70)),
      ]),
      prompt: "Ping the service and tell me what it said.",
      tools: { ping },
      stopWhen: [stepCountIs(1)],
    });

    const message = await lastSnapshot(uiStreamOf(result));

    expect(message?.metadata).not.toHaveProperty("stoppedAtStepLimit");
  });
});
