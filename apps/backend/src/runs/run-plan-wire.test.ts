import { describe, it, expect } from "vitest";
import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { buildModelInvocation, type RunPlan } from "./run-plan.ts";

/**
 * Wire-shape tests for prompt caching (ADR-0020 Notes, issue #682).
 *
 * These assert the request a vendor actually sends, captured on the `fetch`
 * override of a constructed provider — deliberately NOT the SDK-level
 * `providerOptions`. The whole design is arranged around provider packages
 * silently dropping or misplacing an option, so asserting only that we passed
 * the option through would pass even when the cache directive never reached
 * the request. The negative halves (Bedrock has no top-level `cachePoint`;
 * OpenAI and Google carry no cache key at all) are the halves that fail if
 * someone later "simplifies" the wiring. No real credentials are needed.
 */

type CapturedBody = { url: string; body: Record<string, unknown> };

/** A `fetch`-shaped function (the provider configs accept one as `fetch`). */
type RecFetch = (input: unknown, init?: RequestInit) => Promise<Response>;

/** A `fetch` that records each JSON request body, then answers with `payload`. */
const recordingFetch = (captured: CapturedBody[], payload: string): RecFetch => (
  input,
  init,
) => {
  captured.push({
    url: String(input),
    body: JSON.parse(
      typeof init?.body === "string" ? init.body : "",
    ) as Record<string, unknown>,
  });
  return Promise.resolve(
    new Response(payload, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
};

const ANTHROPIC_RESPONSE = JSON.stringify({
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "x",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

const OPENROUTER_RESPONSE = JSON.stringify({
  id: "gen-1",
  model: "x",
  choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const BEDROCK_RESPONSE = JSON.stringify({
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  output: { message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  metrics: { latencyMs: 5 },
});

const OPENAI_RESPONSE = JSON.stringify({
  id: "resp_1",
  object: "response",
  created_at: 0,
  model: "gpt-4o",
  output: [
    {
      id: "msg_001",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    },
  ],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
});

const GOOGLE_RESPONSE = JSON.stringify({
  candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
});

const planWith = (model: LanguageModel): RunPlan => ({
  model,
  tools: {},
  maxSteps: 5,
  system: "You are helpful.",
});

const TWO_TURN = [
  { role: "user" as const, content: "hi" },
  { role: "assistant" as const, content: "hello there" },
  { role: "user" as const, content: "now what" },
];

const runOne = async (model: LanguageModel, prompt?: string) => {
  const invocation = buildModelInvocation(planWith(model), {
    abortSignal: new AbortController().signal,
  });
  return generateText({ ...invocation, ...(prompt ? { prompt } : { messages: TWO_TURN }) });
};

describe("prompt cache wire shape", () => {
  it("Anthropic: a top-level cache directive and no per-block cache_control", async () => {
    const captured: CapturedBody[] = [];
    const model = createAnthropic({
      apiKey: "sk-x",
      fetch: recordingFetch(captured, ANTHROPIC_RESPONSE),
    })("claude-sonnet-4-20250514");
    const result = await runOne(model);

    const body = captured[0].body;
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    // Only ONE cache_control, at the top: every system block and every message
    // content block must be free of block-level cache_control.
    expect(JSON.stringify(body).match(/"cache_control"/g)?.length ?? 0).toBe(1);
    for (const entry of body.system as unknown[]) {
      expect((entry as { cache_control?: unknown }).cache_control).toBeUndefined();
    }
    for (const message of body.messages as Array<{ content: unknown[] }>) {
      for (const part of message.content) {
        expect((part as { cache_control?: unknown }).cache_control).toBeUndefined();
      }
    }
    expect(result.warnings ?? []).toEqual([]);
  });

  it("OpenRouter: a top-level cache directive", async () => {
    const captured: CapturedBody[] = [];
    const model = createOpenRouter({
      apiKey: "sk-x",
      fetch: recordingFetch(captured, OPENROUTER_RESPONSE),
    })("anthropic/claude-3.5-sonnet");
    const result = await runOne(model, "hello");

    const chat = captured.find((c) => c.url.includes("chat/completions"));
    expect(chat?.body.cache_control).toEqual({ type: "ephemeral" });
    expect(result.warnings ?? []).toEqual([]);
  });

  it("Bedrock: cachePoint in system and the final message, never at the top level", async () => {
    const captured: CapturedBody[] = [];
    const model = createAmazonBedrock({
      region: "us-east-1",
      accessKeyId: "a",
      secretAccessKey: "b",
      fetch: recordingFetch(captured, BEDROCK_RESPONSE),
    })("anthropic.claude-3-5-sonnet-20240620-v1:0");
    const result = await runOne(model);

    const body = captured.find((c) => c.url.includes("converse")) ?? captured[0];
    // The trap: a top-level cachePoint is the negative half of this test.
    expect(body.body.cachePoint).toBeUndefined();
    const system = body.body.system as unknown[];
    expect(
      system.some((e) => (e as { cachePoint?: unknown }).cachePoint !== undefined),
    ).toBe(true);
    const messages = body.body.messages as Array<{ content: unknown[] }>;
    const finalContent = messages.at(-1)!.content;
    expect(
      finalContent.some((e) => (e as { cachePoint?: unknown }).cachePoint !== undefined),
    ).toBe(true);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("OpenAI and Google: no cache key anywhere and no warnings", async () => {
    const cases = [
      {
        response: OPENAI_RESPONSE,
        model: (fetch: RecFetch) => createOpenAI({ apiKey: "sk-x", fetch })("gpt-4o"),
      },
      {
        response: GOOGLE_RESPONSE,
        model: (fetch: RecFetch) =>
          createGoogleGenerativeAI({ apiKey: "sk-x", fetch })("gemini-2.5-pro"),
      },
    ];

    for (const cfg of cases) {
      const captured: CapturedBody[] = [];
      const model = cfg.model(recordingFetch(captured, cfg.response));
      const result = await runOne(model, "hello");

      // The emitted request carries no cache key — the vendor namespaces are
      // read by their own packages and dropped, not forwarded.
      for (const { body } of captured) {
        expect(JSON.stringify(body)).not.toMatch(/cache_control|cachePoint|cacheControl|"head"/i);
      }
      expect(result.warnings ?? []).toEqual([]);
    }
  });
});
