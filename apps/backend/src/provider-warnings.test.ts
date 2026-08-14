import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateText, stepCountIs, ToolLoopAgent, type Warning } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

vi.mock("./logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { logger } from "./logger.ts";
import { installProviderWarningLogger } from "./provider-warnings.ts";

/** Call the hook the way the SDK does, through the global it reads. */
const emit = (options: {
  warnings: Warning[];
  provider?: string;
  model?: string;
}) => {
  const log = globalThis.AI_SDK_LOG_WARNINGS;
  if (typeof log !== "function") {
    throw new Error("no warning logger installed");
  }
  log(options);
};

/** The `(fields, message)` pair of the nth `logger.warn` call. */
const warnCall = (index: number) => {
  const call = vi.mocked(logger.warn).mock.calls[index] as unknown as [
    Record<string, unknown>,
    string,
  ];
  return { fields: call[0], message: call[1] };
};

describe("installProviderWarningLogger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete globalThis.AI_SDK_LOG_WARNINGS;
    installProviderWarningLogger();
  });

  afterEach(() => {
    delete globalThis.AI_SDK_LOG_WARNINGS;
  });

  it("installs itself on the global the SDK reads", () => {
    expect(typeof globalThis.AI_SDK_LOG_WARNINGS).toBe("function");
  });

  it("logs an unsupported parameter with its feature, provider and model", () => {
    emit({
      warnings: [
        {
          type: "unsupported",
          feature: "seed",
          details: "seed is not supported by Bedrock",
        },
      ],
      provider: "amazon-bedrock",
      model: "anthropic.claude-opus-4-5-v1:0",
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const { fields, message } = warnCall(0);
    expect(fields).toEqual({
      provider: "amazon-bedrock",
      model: "anthropic.claude-opus-4-5-v1:0",
      warningType: "unsupported",
      feature: "seed",
      details: "seed is not supported by Bedrock",
    });
    expect(message).toContain("seed");
    expect(message).toContain("amazon-bedrock");
    expect(message).toContain("anthropic.claude-opus-4-5-v1:0");
    expect(message).toContain("seed is not supported by Bedrock");
  });

  it("keeps the provider's own explanation for a clamped temperature", () => {
    emit({
      warnings: [
        {
          type: "unsupported",
          feature: "temperature",
          details: "1.5 exceeds bedrock maximum of 1.0. clamped to 1.0",
        },
      ],
      provider: "amazon-bedrock",
      model: "anthropic.claude-sonnet-4-5-v1:0",
    });

    const { fields, message } = warnCall(0);
    expect(fields.feature).toBe("temperature");
    expect(fields.details).toBe(
      "1.5 exceeds bedrock maximum of 1.0. clamped to 1.0",
    );
    expect(message).toContain(
      "1.5 exceeds bedrock maximum of 1.0. clamped to 1.0",
    );
  });

  it("logs a line per warning when one call raises several", () => {
    emit({
      warnings: [
        { type: "unsupported", feature: "frequencyPenalty" },
        { type: "unsupported", feature: "presencePenalty" },
        { type: "unsupported", feature: "seed" },
      ],
      provider: "amazon-bedrock",
      model: "anthropic.claude-opus-4-5-v1:0",
    });

    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((i) => warnCall(i).fields.feature)).toEqual([
      "frequencyPenalty",
      "presencePenalty",
      "seed",
    ]);
  });

  it("logs nothing when a generation raises no warnings", () => {
    emit({ warnings: [], provider: "anthropic", model: "claude-opus-4-5" });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("omits a feature's details when the provider gave none", () => {
    emit({
      warnings: [{ type: "unsupported", feature: "topK" }],
      provider: "anthropic",
      model: "claude-opus-4-5",
    });

    const { fields, message } = warnCall(0);
    expect(fields).not.toHaveProperty("details");
    expect(message).not.toContain("undefined");
  });

  it("names a compatibility fallback, such as an unrecognised model id", () => {
    emit({
      warnings: [
        {
          type: "compatibility",
          feature: "maxOutputTokens",
          details:
            'The model "claude-opus-9" is unknown. The max output tokens have been limited to 8192.',
        },
      ],
      provider: "anthropic",
      model: "claude-opus-9",
    });

    const { fields, message } = warnCall(0);
    expect(fields.warningType).toBe("compatibility");
    expect(fields.feature).toBe("maxOutputTokens");
    expect(message).toContain("claude-opus-9");
  });

  it("names the deprecated setting and what to use instead", () => {
    emit({
      warnings: [
        {
          type: "deprecated",
          setting: "topK",
          message: "Use topP instead.",
        },
      ],
      provider: "openai",
      model: "gpt-5",
    });

    const { fields, message } = warnCall(0);
    expect(fields.warningType).toBe("deprecated");
    expect(fields.setting).toBe("topK");
    expect(message).toContain("topK");
    expect(message).toContain("Use topP instead.");
  });

  it("passes through a warning that carries only a message", () => {
    emit({
      warnings: [{ type: "other", message: "Something the provider noticed." }],
      provider: "openai",
      model: "gpt-5",
    });

    const { fields, message } = warnCall(0);
    expect(fields.warningType).toBe("other");
    expect(message).toContain("Something the provider noticed.");
  });

  it("still logs when the SDK reports no provider or model", () => {
    emit({ warnings: [{ type: "unsupported", feature: "seed" }] });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const { fields, message } = warnCall(0);
    expect(fields).not.toHaveProperty("provider");
    expect(fields).not.toHaveProperty("model");
    expect(message).not.toContain("undefined");
  });
});

/**
 * The wiring, driven through the SDK rather than through the global directly.
 *
 * This is what makes "install it once and every call site is covered" a claim
 * the suite checks: the model here is a stand-in for any Provider, and nothing
 * in the calling code mentions warnings.
 */
describe("warnings raised by a generation", () => {
  const usage = {
    inputTokens: {
      total: 1,
      noCache: 1,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  const finishReason = { unified: "stop" as const, raw: "end_turn" };

  const model = (warnings: Warning[]) =>
    new MockLanguageModelV4({
      provider: "amazon-bedrock",
      modelId: "anthropic.claude-opus-4-5-v1:0",
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: "text" as const, text: "ok" }],
          finishReason,
          usage,
          warnings,
        }),
      doStream: () =>
        Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings },
              { type: "text-start" as const, id: "1" },
              { type: "text-delta" as const, id: "1", delta: "ok" },
              { type: "text-end" as const, id: "1" },
              { type: "finish" as const, finishReason, usage },
            ],
          }),
        }),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    delete globalThis.AI_SDK_LOG_WARNINGS;
    installProviderWarningLogger();
  });

  afterEach(() => {
    delete globalThis.AI_SDK_LOG_WARNINGS;
  });

  it("reaches the log without the call site asking for them", async () => {
    await generateText({
      model: model([{ type: "unsupported", feature: "seed" }]),
      prompt: "hello",
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(warnCall(0).fields).toMatchObject({
      provider: "amazon-bedrock",
      model: "anthropic.claude-opus-4-5-v1:0",
      feature: "seed",
    });
  });

  it("replaces the SDK's own logger rather than adding to it", async () => {
    const emitWarning = vi
      .spyOn(process, "emitWarning")
      .mockImplementation(() => {});

    await generateText({
      model: model([{ type: "unsupported", feature: "seed" }]),
      prompt: "hello",
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(emitWarning).not.toHaveBeenCalled();
    emitWarning.mockRestore();
  });

  it("stays quiet for a generation the Provider had nothing to say about", async () => {
    await generateText({ model: model([]), prompt: "hello" });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  // The same construction a sub-agent run uses: a `ToolLoopAgent` streamed to
  // completion. Warnings arrive on a stream part rather than a result object
  // here, which is the case a per-call-site read of `warnings` would have had
  // to handle separately.
  it("reaches the log from a sub-agent's streamed run", async () => {
    const subAgent = new ToolLoopAgent({
      model: model([
        {
          type: "unsupported",
          feature: "temperature",
          details: "temperature is not supported by this model",
        },
      ]),
      instructions: "You are a specialized sub-agent.",
      temperature: 0.7,
      stopWhen: [stepCountIs(1)],
    });

    const result = await subAgent.stream({ prompt: "do the thing" });
    await result.consumeStream();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(warnCall(0).fields).toMatchObject({
      provider: "amazon-bedrock",
      feature: "temperature",
    });
  });
});
