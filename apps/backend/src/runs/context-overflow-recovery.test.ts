import { describe, it, expect } from "vitest";
import { APICallError, simulateReadableStream, type Tool } from "ai";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { startRun } from "./run-lifecycle.ts";
import { driveChat, driveDelegate, driveOnce } from "./drive.ts";
import { CONTEXT_OVERFLOW_MESSAGE } from "./stream-error.ts";
import { TOOL_RESULT_TOO_LARGE } from "./context-overflow-recovery.ts";
import type { RunStatus } from "./types.ts";

/**
 * Context-overflow recovery (issue #1717), driven through the real AI SDK
 * pipeline with a scripted model: R3 — an overflow straight after a tool step
 * fails that step's tool calls and retries the call once — and R1 — any
 * overflow left unrecovered ends with the actionable message, on every Drive.
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

type Reply = "tool" | "text" | "overflow";

const overflow = () =>
  new APICallError({
    message: "prompt is too long: 208310 tokens > 200000 maximum",
    url: "https://provider.example/v1/messages",
    requestBodyValues: {},
    statusCode: 400,
    responseBody:
      '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 208310 tokens > 200000 maximum"}}',
  });

const toolCallStream = (): LanguageModelV3StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "tool-input-start", id: "tc1", toolName: "readBig" },
  { type: "tool-input-end", id: "tc1" },
  { type: "tool-call", toolCallId: "tc1", toolName: "readBig", input: "{}" },
  {
    type: "finish",
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: USAGE,
  },
];

const textStream = (): LanguageModelV3StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "narrower next time" },
  { type: "text-end", id: "t1" },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: USAGE,
  },
];

/** A model that answers each call from `script` and records every prompt. */
const scriptedModel = (...script: Reply[]) => {
  const prompts: LanguageModelV3CallOptions["prompt"][] = [];
  const model = new MockLanguageModelV3({
    doStream: (options) => {
      prompts.push(options.prompt);
      const reply = script[prompts.length - 1] ?? "text";
      if (reply === "overflow") return Promise.reject(overflow());
      return Promise.resolve({
        stream: simulateReadableStream({
          chunks: reply === "tool" ? toolCallStream() : textStream(),
        }),
      });
    },
  });
  return { model, prompts };
};

const planOf = (model: MockLanguageModelV3) => ({
  model,
  maxSteps: 5,
  tools: {
    readBig: {
      inputSchema: z.object({}),
      execute: () => Promise.resolve("x".repeat(1000)),
    },
  } as unknown as Record<string, Tool>,
});

const startRecordedRun = () => {
  const outcome: Array<{ status: RunStatus; error?: Error }> = [];
  const run = startRun({
    runId: `overflow-${Math.random().toString(36).slice(2)}`,
    onTerminate: ({ status, error }) => {
      outcome.push({ status, error });
    },
  });
  return { run, outcome };
};

/** The tool-result parts of the last tool message in a recorded prompt. */
const toolResultsOf = (prompt: LanguageModelV3CallOptions["prompt"]) =>
  prompt
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .filter((part) => part.type === "tool-result");

const runChat = async (model: MockLanguageModelV3) => {
  const { run, outcome } = startRecordedRun();
  const drive = driveChat({
    plan: planOf(model),
    run,
    modelMessages: [{ role: "user", content: "read the big thing" }],
  });
  const chunks: unknown[] = [];
  const reading = (async () => {
    for await (const chunk of drive.response) chunks.push(chunk);
  })();
  for await (const _ of drive.snapshots) void _;
  const result = await drive.done;
  await reading;
  return { result, outcome, chunks };
};

describe("an overflow right after a tool step (R3)", () => {
  it("replaces the step's tool results with the tool error and retries the call once", async () => {
    const { model, prompts } = scriptedModel("tool", "overflow", "text");

    const { result } = await runChat(model);

    // Tool call, the overflowing call, and exactly one retry.
    expect(prompts).toHaveLength(3);
    expect(toolResultsOf(prompts[1])[0]?.output).toMatchObject({
      type: "text",
    });
    expect(toolResultsOf(prompts[2])[0]?.output).toEqual({
      type: "error-text",
      value: TOOL_RESULT_TOO_LARGE,
    });
    expect(result.status).toBe("succeeded");
    expect(result.failure).toBeUndefined();
  });

  it("stores the tool error as that call's result, so the Transcript re-sends it", async () => {
    const { model } = scriptedModel("tool", "overflow", "text");

    const { result, chunks } = await runChat(model);

    const reply = result.messages?.at(-1);
    // `readBig` is a test tool the Chat's UI contract does not name.
    const toolPart = reply?.parts.find(
      (part) => (part.type as string) === "tool-readBig",
    );
    expect(toolPart).toMatchObject({
      state: "output-error",
      errorText: TOOL_RESULT_TOO_LARGE,
    });
    expect(reply?.parts.some((part) => part.type === "text")).toBe(true);
    // The client is told too, replacing the result it was already shown.
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: "tool-output-error",
        toolCallId: "tc1",
        errorText: TOOL_RESULT_TOO_LARGE,
      }),
    );
  });

  it("keeps the replaced result replaced on every later step of the turn", async () => {
    const { model, prompts } = scriptedModel(
      "tool",
      "overflow",
      "tool",
      "text",
    );

    await runChat(model);

    expect(prompts).toHaveLength(4);
    const results = toolResultsOf(prompts[3]);
    expect(results[0]?.output).toEqual({
      type: "error-text",
      value: TOOL_RESULT_TOO_LARGE,
    });
  });

  it("ends with the actionable message when the retried call overflows too — never a second retry", async () => {
    const { model, prompts } = scriptedModel("tool", "overflow", "overflow");

    const { chunks } = await runChat(model);

    expect(prompts).toHaveLength(3);
    expect(chunks).toContainEqual({
      type: "error",
      errorText: CONTEXT_OVERFLOW_MESSAGE,
    });
  });
});

describe("an overflow with no tool step before it (R1)", () => {
  it("tells the Chat's User the conversation is too long, without retrying", async () => {
    const { model, prompts } = scriptedModel("overflow");

    const { chunks } = await runChat(model);

    expect(prompts).toHaveLength(1);
    expect(chunks).toContainEqual({
      type: "error",
      errorText: CONTEXT_OVERFLOW_MESSAGE,
    });
  });

  it("marks the Chat's reply as overflowed, so the next turn summarises first", async () => {
    const { model } = scriptedModel("tool", "overflow", "overflow");

    const { result } = await runChat(model);

    const reply = result.messages?.at(-1) ?? result.latest;
    expect(reply?.metadata?.contextOverflow).toBe(true);
  });

  it("does not mark a reply that failed for another reason", async () => {
    const model = new MockLanguageModelV3({
      doStream: () =>
        Promise.reject(
          new APICallError({
            message: "Invalid schema for function 'readBig'",
            url: "https://provider.example/v1",
            requestBodyValues: {},
            statusCode: 400,
          }),
        ),
    });

    const { result } = await runChat(model);

    const reply = result.messages?.at(-1) ?? result.latest;
    expect(reply?.metadata?.contextOverflow).toBeUndefined();
  });

  it("fails a Trigger run with the actionable message", async () => {
    const { model } = scriptedModel("overflow");
    const { run, outcome } = startRecordedRun();

    await expect(
      driveOnce({ plan: planOf(model), run, prompt: "hi" }),
    ).rejects.toThrow(CONTEXT_OVERFLOW_MESSAGE);
    expect(outcome[0]?.status).toBe("failed");
  });

  it("fails a Sub-Agent run with the actionable message", async () => {
    const { model } = scriptedModel("overflow");
    const { run } = startRecordedRun();

    const drive = driveDelegate({
      plan: planOf(model),
      run,
      prompt: "hi",
      agentId: "agent-1",
    });
    for await (const _ of drive.snapshots) void _;
    const result = await drive.done;

    expect(result.status).toBe("failed");
    expect(result.failure).toBe(CONTEXT_OVERFLOW_MESSAGE);
  });
});
