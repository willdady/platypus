import { describe, it, expect, vi } from "vitest";
import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { ModelConfig } from "@platypus/schemas";
import {
  buildModelInvocation,
  REQUEST_LEVEL_CACHE_DIRECTIVE,
  type RunPlan,
} from "./run-plan.ts";
import { resolveGenerationPlan } from "./agent-plan.ts";
import { makeProviderRow } from "../services/provider-row.test-fixtures.ts";
import type { SamplingSource } from "../services/sampling-settings.ts";

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
const recordingFetch =
  (captured: CapturedBody[], payload: string): RecFetch =>
  (input, init) => {
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
  choices: [
    { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const BEDROCK_RESPONSE = JSON.stringify({
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  output: {
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
  },
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
  usageMetadata: {
    promptTokenCount: 10,
    candidatesTokenCount: 5,
    totalTokenCount: 15,
  },
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
  return generateText({
    ...invocation,
    ...(prompt ? { prompt } : { messages: TWO_TURN }),
  });
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
      expect(
        (entry as { cache_control?: unknown }).cache_control,
      ).toBeUndefined();
    }
    for (const message of body.messages as Array<{ content: unknown[] }>) {
      for (const part of message.content) {
        expect(
          (part as { cache_control?: unknown }).cache_control,
        ).toBeUndefined();
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

    const body =
      captured.find((c) => c.url.includes("converse")) ?? captured[0];
    // The trap: a top-level cachePoint is the negative half of this test.
    expect(body.body.cachePoint).toBeUndefined();
    const system = body.body.system as unknown[];
    expect(
      system.some(
        (e) => (e as { cachePoint?: unknown }).cachePoint !== undefined,
      ),
    ).toBe(true);
    const messages = body.body.messages as Array<{ content: unknown[] }>;
    const finalContent = messages.at(-1)!.content;
    expect(
      finalContent.some(
        (e) => (e as { cachePoint?: unknown }).cachePoint !== undefined,
      ),
    ).toBe(true);
    expect(result.warnings ?? []).toEqual([]);
  });

  it("OpenAI and Google: no cache key anywhere and no warnings", async () => {
    const cases = [
      {
        response: OPENAI_RESPONSE,
        model: (fetch: RecFetch) =>
          createOpenAI({ apiKey: "sk-x", fetch })("gpt-4o"),
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
        expect(JSON.stringify(body)).not.toMatch(
          /cache_control|cachePoint|cacheControl|"head"/i,
        );
      }
      expect(result.warnings ?? []).toEqual([]);
    }
  });
});

/**
 * Reasoning map wire shape (ADR-0040, issue #1521): the body an OpenAI
 * chat-mode Provider sends once a Model entry's map is resolved. Driven through
 * `resolveGenerationPlan` with a stubbed global `fetch`, so the namespace the
 * fragment rides under is the one `@ai-sdk/openai-compatible` really reads.
 */
describe("Reasoning map wire shape", () => {
  const COMPAT_RESPONSE = OPENROUTER_RESPONSE;

  const send = async (
    reasoning: ModelConfig["reasoning"],
    choice: SamplingSource = {},
  ) => {
    const captured: CapturedBody[] = [];
    vi.stubGlobal("fetch", recordingFetch(captured, COMPAT_RESPONSE));
    try {
      const provider = makeProviderRow({
        id: "p1",
        name: "local-vllm",
        organizationId: "org-1",
        workspaceId: "ws-1",
        providerType: "OpenAI",
        apiMode: "chat",
        baseUrl: "http://vllm.test/v1",
        apiKey: "sk-x",
        modelIds: [{ id: "m", passthroughFileTypes: [], reasoning }],
      });
      const { plan } = await resolveGenerationPlan(
        { providerId: "p1", modelId: "m", ...choice },
        { orgId: "org-1", workspaceId: "ws-1" },
        { getProvider: () => Promise.resolve(provider) },
      );
      const result = await generateText({
        ...buildModelInvocation(
          { ...plan, tools: {}, system: "You are helpful." },
          { abortSignal: new AbortController().signal },
        ),
        prompt: "hello",
      });
      return { body: captured[0].body, warnings: result.warnings ?? [] };
    } finally {
      vi.unstubAllGlobals();
    }
  };

  // The request every OpenAI chat-mode turn sent before Reasoning maps
  // existed. Pinned literally: a map-less model must still send exactly this.
  const BASELINE = {
    model: "m",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
    ],
  };

  it("sends today's body for a model with no map and a choice of all nulls", async () => {
    const { body } = await send(undefined, {
      reasoningThinking: null,
      reasoningEffort: null,
      thinkingBudget: null,
    });
    expect(body).toEqual(BASELINE);
  });

  it("sends today's body for a map that resolves to nothing", async () => {
    const { body } = await send({ effort: { low: { think: "low" } } });
    expect(body).toEqual(BASELINE);
  });

  it("Qwen 3.6: thinking switch, budget and an always fragment", async () => {
    const { body } = await send(
      {
        always: { chat_template_kwargs: { preserve_thinking: true } },
        thinking: {
          on: { chat_template_kwargs: { enable_thinking: true } },
          off: { chat_template_kwargs: { enable_thinking: false } },
        },
        budget: { field: "thinking_token_budget" },
        default: { thinking: true },
      },
      { thinkingBudget: 2048 },
    );
    expect(body).toEqual({
      ...BASELINE,
      chat_template_kwargs: { preserve_thinking: true, enable_thinking: true },
      thinking_token_budget: 2048,
    });
  });

  const DEEPSEEK: ModelConfig["reasoning"] = {
    thinking: { on: {}, off: { reasoningEffort: "none" } },
    effort: {
      low: { chat_template_kwargs: { reasoning_effort: "low" } },
      high: { chat_template_kwargs: { reasoning_effort: "high" } },
      xhigh: { chat_template_kwargs: { reasoning_effort: "xhigh" } },
      max: { chat_template_kwargs: { reasoning_effort: "max" } },
    },
    budget: { field: "thinking_token_budget" },
    default: { effort: "high" },
  };

  it("DeepSeek V4.1 Flash: the default effort step", async () => {
    const { body } = await send(DEEPSEEK);
    expect(body).toEqual({
      ...BASELINE,
      chat_template_kwargs: { reasoning_effort: "high" },
    });
  });

  it("DeepSeek V4.1 Flash: thinking off sends top-level reasoning_effort via the SDK's reasoningEffort", async () => {
    const { body } = await send(DEEPSEEK, {
      reasoningThinking: false,
      reasoningEffort: "max",
      thinkingBudget: 100,
    });
    expect(body).toEqual({ ...BASELINE, reasoning_effort: "none" });
  });

  it("a raw top-level reasoning_effort in a fragment never reaches the wire", async () => {
    const { body } = await send({ always: { reasoning_effort: "low" } });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("Ollama: its own think field", async () => {
    const { body } = await send(
      {
        thinking: { on: { think: true }, off: { think: false } },
        effort: {
          low: { think: "low" },
          medium: { think: "medium" },
          high: { think: "high" },
        },
      },
      { reasoningThinking: true, reasoningEffort: "medium" },
    );
    expect(body).toEqual({ ...BASELINE, think: "medium" });
  });

  it("the Agent's temperature beats a fragment's; a cleared one lets it through", async () => {
    const map = { always: { temperature: 0.6, top_p: 0.95 } };
    expect((await send(map, { temperature: 0.2 })).body).toMatchObject({
      temperature: 0.2,
      top_p: 0.95,
    });
    expect((await send(map, { temperature: null })).body).toMatchObject({
      temperature: 0.6,
    });
  });

  it("keeps the cache directives beside the fragment", () => {
    const invocation = buildModelInvocation(
      {
        ...planWith(createOpenAI({ apiKey: "sk-x" })("gpt-4o")),
        providerOptions: { "local-vllm": { think: true } },
      },
      { abortSignal: new AbortController().signal },
    );
    expect(invocation.providerOptions).toEqual({
      ...REQUEST_LEVEL_CACHE_DIRECTIVE,
      "local-vllm": { think: true },
    });
  });

  it("merges into a cache namespace rather than replacing it", () => {
    const invocation = buildModelInvocation(
      {
        ...planWith(createOpenAI({ apiKey: "sk-x" })("gpt-4o")),
        providerOptions: { anthropic: { think: true } },
      },
      { abortSignal: new AbortController().signal },
    );
    expect(invocation.providerOptions.anthropic).toEqual({
      ...REQUEST_LEVEL_CACHE_DIRECTIVE.anthropic,
      think: true,
    });
  });

  it("ignores a map on a Provider other than OpenAI chat mode", async () => {
    const provider = makeProviderRow({
      id: "p1",
      name: "openai",
      organizationId: "org-1",
      workspaceId: "ws-1",
      providerType: "OpenAI",
      apiMode: "responses",
      apiKey: "sk-x",
      modelIds: [
        { id: "m", passthroughFileTypes: [], reasoning: { always: { a: 1 } } },
      ],
    });
    const { plan } = await resolveGenerationPlan(
      { providerId: "p1", modelId: "m" },
      { orgId: "org-1", workspaceId: "ws-1" },
      { getProvider: () => Promise.resolve(provider) },
    );
    expect(plan.providerOptions).toBeUndefined();
  });
});

/**
 * Native Reasoning wire shape (#1689): with no Reasoning map, an Agent's or
 * Direct Chat's Thinking/Effort choice reaches a native Provider through the
 * SDK's `reasoning` call option, which each vendor adapter translates itself —
 * except OpenRouter, whose adapter ignores that option and reads its own.
 */
describe("native Reasoning wire shape", () => {
  const NATIVE = [
    {
      providerType: "Anthropic" as const,
      modelId: "claude-sonnet-4-20250514",
      response: ANTHROPIC_RESPONSE,
      reasoningOf: (body: Record<string, unknown>) => body.thinking,
    },
    {
      providerType: "Google" as const,
      modelId: "gemini-2.5-pro",
      response: GOOGLE_RESPONSE,
      reasoningOf: (body: Record<string, unknown>) =>
        (body.generationConfig as { thinkingConfig?: unknown } | undefined)
          ?.thinkingConfig,
    },
    {
      providerType: "OpenAI" as const,
      modelId: "o3",
      response: OPENAI_RESPONSE,
      reasoningOf: (body: Record<string, unknown>) => body.reasoning,
    },
    {
      providerType: "Bedrock" as const,
      modelId: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      response: BEDROCK_RESPONSE,
      reasoningOf: (body: Record<string, unknown>) =>
        body.additionalModelRequestFields,
    },
    {
      providerType: "OpenRouter" as const,
      modelId: "openai/o3",
      response: OPENROUTER_RESPONSE,
      reasoningOf: (body: Record<string, unknown>) => body.reasoning,
    },
  ];

  const send = async (
    vendor: (typeof NATIVE)[number],
    choice: SamplingSource = {},
  ) => {
    const captured: CapturedBody[] = [];
    vi.stubGlobal("fetch", recordingFetch(captured, vendor.response));
    try {
      const provider = makeProviderRow({
        id: "p1",
        name: "native",
        organizationId: "org-1",
        workspaceId: "ws-1",
        providerType: vendor.providerType,
        apiMode: "responses",
        region: "us-east-1",
        apiKey: "sk-x",
        modelIds: [{ id: vendor.modelId, passthroughFileTypes: [] }],
      });
      const { plan } = await resolveGenerationPlan(
        { providerId: "p1", modelId: vendor.modelId, ...choice },
        { orgId: "org-1", workspaceId: "ws-1" },
        { getProvider: () => Promise.resolve(provider) },
      );
      await generateText({
        ...buildModelInvocation(
          { ...plan, tools: {}, system: "You are helpful." },
          { abortSignal: new AbortController().signal },
        ),
        prompt: "hello",
      });
      return captured[0].body;
    } finally {
      vi.unstubAllGlobals();
    }
  };

  for (const vendor of NATIVE) {
    it(`${vendor.providerType}: no choice sends no reasoning control`, async () => {
      expect(vendor.reasoningOf(await send(vendor))).toBeUndefined();
      expect(
        vendor.reasoningOf(
          await send(vendor, {
            reasoningThinking: null,
            reasoningEffort: null,
            thinkingBudget: null,
          }),
        ),
      ).toBeUndefined();
    });

    it(`${vendor.providerType}: a chosen Effort step reaches the wire`, async () => {
      expect(
        vendor.reasoningOf(await send(vendor, { reasoningEffort: "high" })),
      ).toBeDefined();
    });

    // Bedrock's Claude leaves thinking out when it is off — its default — so
    // there off and no choice are the same request (pinned below).
    it.skipIf(vendor.providerType === "Bedrock")(
      `${vendor.providerType}: Thinking off reaches the wire`,
      async () => {
        expect(
          vendor.reasoningOf(
            await send(vendor, {
              reasoningThinking: false,
              reasoningEffort: "high",
            }),
          ),
        ).toBeDefined();
      },
    );

    it(`${vendor.providerType}: a Thinking budget is never sent`, async () => {
      expect(
        JSON.stringify(
          await send(vendor, { reasoningEffort: "high", thinkingBudget: 1234 }),
        ),
      ).not.toContain("1234");
    });
  }

  const byType = (providerType: (typeof NATIVE)[number]["providerType"]) =>
    NATIVE.find((v) => v.providerType === providerType)!;

  it("Bedrock: Thinking off sends no thinking, Claude's default", async () => {
    expect(
      byType("Bedrock").reasoningOf(
        await send(byType("Bedrock"), {
          reasoningThinking: false,
          reasoningEffort: "high",
        }),
      ),
    ).toBeUndefined();
  });

  it("Anthropic: Thinking off disables thinking", async () => {
    expect(
      (
        await send(byType("Anthropic"), {
          reasoningThinking: false,
          reasoningEffort: "high",
        })
      ).thinking,
    ).toEqual({ type: "disabled" });
  });

  it("OpenAI Responses: the step goes out as reasoning.effort", async () => {
    expect(
      (await send(byType("OpenAI"), { reasoningEffort: "low" })).reasoning,
    ).toMatchObject({ effort: "low" });
  });

  const OPENROUTER = byType("OpenRouter");

  it("OpenRouter: the step goes out as reasoning.effort", async () => {
    expect(
      (await send(OPENROUTER, { reasoningEffort: "low" })).reasoning,
    ).toEqual({ effort: "low" });
  });

  it("OpenRouter: max is capped at xhigh, which is its highest step", async () => {
    expect(
      (await send(OPENROUTER, { reasoningEffort: "max" })).reasoning,
    ).toEqual({ effort: "xhigh" });
  });

  it("OpenRouter: Thinking off sends effort none, and keeps the cache directive", async () => {
    const body = await send(OPENROUTER, {
      reasoningThinking: false,
      reasoningEffort: "high",
    });
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.cache_control).toEqual({ type: "ephemeral" });
  });

  it("an OpenAI chat-mode model with no map still sends nothing", async () => {
    const provider = makeProviderRow({
      id: "p1",
      organizationId: "org-1",
      workspaceId: "ws-1",
      providerType: "OpenAI",
      apiMode: "chat",
      modelIds: [{ id: "m", passthroughFileTypes: [] }],
    });
    const { plan } = await resolveGenerationPlan(
      { providerId: "p1", modelId: "m", reasoningEffort: "high" },
      { orgId: "org-1", workspaceId: "ws-1" },
      { getProvider: () => Promise.resolve(provider) },
    );
    expect(plan.reasoning).toBeUndefined();
    expect(plan.providerOptions).toBeUndefined();
  });
});
