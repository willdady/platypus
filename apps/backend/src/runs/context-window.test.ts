import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger.ts", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  ContextWindowResolver,
  lookupRegistry,
  DEFAULT_CONTEXT_WINDOW,
  type Registry,
  type ProviderWindowInput,
} from "./context-window.ts";

const REGISTRY: Registry = {
  "gpt-4o": { max_input_tokens: 128000, max_output_tokens: 16384 },
  "claude-3-5-sonnet-20240620": {
    max_input_tokens: 200000,
    max_output_tokens: 8192,
  },
  "anthropic.claude-3-5-sonnet-20240620-v1:0": {
    max_input_tokens: 200000,
    max_output_tokens: 4096,
  },
  "legacy-model": { max_tokens: 4096 },
};

const loadRegistry = async () => REGISTRY;

function resolver() {
  return new ContextWindowResolver({ loadRegistry });
}

const openai: ProviderWindowInput = {
  id: "prov-openai",
  providerType: "OpenAI",
  baseUrl: null,
  apiKey: "sk-x",
};

describe("lookupRegistry — key normalization (drift T4)", () => {
  it("exact match", () => {
    expect(lookupRegistry(REGISTRY, "gpt-4o")?.max_input_tokens).toBe(128000);
  });

  it("strips a provider prefix", () => {
    expect(lookupRegistry(REGISTRY, "openai/gpt-4o")?.max_input_tokens).toBe(
      128000,
    );
  });

  it("lowercases", () => {
    expect(lookupRegistry(REGISTRY, "GPT-4o")?.max_input_tokens).toBe(128000);
  });

  it("uses the alias map for an Azure deployment name", () => {
    expect(
      lookupRegistry(REGISTRY, "my-azure-deploy", {
        "my-azure-deploy": "gpt-4o",
      })?.max_input_tokens,
    ).toBe(128000);
  });

  it("resolves a Bedrock ARN to its vendor.model id", () => {
    const arn =
      "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0";
    expect(lookupRegistry(REGISTRY, arn)?.max_output_tokens).toBe(4096);
  });

  it("family heuristic: dated suffix matches the base key", () => {
    // "gpt-4o-2024-11-20" → longest prefix key "gpt-4o"
    expect(
      lookupRegistry(REGISTRY, "gpt-4o-2024-11-20")?.max_input_tokens,
    ).toBe(128000);
  });

  it("returns undefined on a true MISS", () => {
    expect(lookupRegistry(REGISTRY, "totally-unknown-xyz")).toBeUndefined();
  });
});

describe("resolveContextWindow — resolution order", () => {
  beforeEach(() => vi.clearAllMocks());

  it("1. manual override wins over everything", async () => {
    const r = resolver();
    const out = await r.resolve(
      {
        ...openai,
        modelMeta: {
          "gpt-4o": { contextWindow: 64000, maxOutputTokens: 2048 },
        },
      },
      "gpt-4o",
    );
    expect(out).toEqual({
      contextWindow: 64000,
      maxOutputTokens: 2048,
      source: "override",
    });
  });

  it("3. falls to the litellm registry when no override / API", async () => {
    const r = resolver();
    const out = await r.resolve({ ...openai }, "gpt-4o");
    expect(out).toEqual({
      contextWindow: 128000,
      maxOutputTokens: 16384,
      source: "registry",
    });
  });

  it("ignores litellm max_tokens (output cap, not window) → default (drift F1)", async () => {
    // "legacy-model" has only max_tokens; that is the OUTPUT cap, so it must NOT
    // be read as the context window. Falls through to the conservative default.
    const r = resolver();
    const out = await r.resolve({ ...openai }, "legacy-model");
    expect(out.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(out.source).toBe("default");
  });

  it("merges a maxOutputTokens-only override onto a registry window (drift F5)", async () => {
    const r = resolver();
    const out = await r.resolve(
      { ...openai, modelMeta: { "gpt-4o": { maxOutputTokens: 999 } } },
      "gpt-4o",
    );
    // No contextWindow override → window from registry, but output cap overridden.
    expect(out).toEqual({
      contextWindow: 128000,
      maxOutputTokens: 999,
      source: "registry",
    });
  });

  it("4. conservative default + source=default on a MISS (drift T6)", async () => {
    const r = resolver();
    const out = await r.resolve({ ...openai }, "unknown-model-zzz");
    expect(out).toEqual({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: undefined,
      source: "default",
    });
  });
});

describe("API auto-detect parsers", () => {
  it("Google: inputTokenLimit / outputTokenLimit", async () => {
    const httpGetJson = vi.fn().mockResolvedValue({
      inputTokenLimit: 1048576,
      outputTokenLimit: 8192,
    });
    const r = new ContextWindowResolver({ loadRegistry, httpGetJson });
    const out = await r.resolve(
      {
        id: "g",
        providerType: "Google",
        baseUrl: "https://gen.example",
        apiKey: "k",
      },
      "gemini-1.5-pro",
    );
    expect(out).toEqual({
      contextWindow: 1048576,
      maxOutputTokens: 8192,
      source: "api",
    });
    expect(httpGetJson).toHaveBeenCalledWith(
      "https://gen.example/v1beta/models/gemini-1.5-pro",
      { "x-goog-api-key": "k" },
    );
  });

  it("OpenRouter: matches id → context_length", async () => {
    const httpGetJson = vi.fn().mockResolvedValue({
      data: [
        { id: "other", context_length: 1 },
        {
          id: "meta-llama/llama-3.1-70b",
          context_length: 131072,
          top_provider: { max_completion_tokens: 4096 },
        },
      ],
    });
    const r = new ContextWindowResolver({ loadRegistry, httpGetJson });
    const out = await r.resolve(
      {
        id: "or",
        providerType: "OpenRouter",
        baseUrl: "https://openrouter.ai",
      },
      "meta-llama/llama-3.1-70b",
    );
    expect(out).toEqual({
      contextWindow: 131072,
      maxOutputTokens: 4096,
      source: "api",
    });
  });

  it("vLLM / OpenAI-compatible: max_model_len from a custom baseUrl", async () => {
    const httpGetJson = vi.fn().mockResolvedValue({
      data: [{ id: "my-vllm-model", max_model_len: 32768 }],
    });
    const r = new ContextWindowResolver({ loadRegistry, httpGetJson });
    const out = await r.resolve(
      {
        id: "v",
        providerType: "OpenAI",
        baseUrl: "http://localhost:8000",
        apiKey: "x",
      },
      "my-vllm-model",
    );
    expect(out.contextWindow).toBe(32768);
    expect(out.source).toBe("api");
  });

  it("vLLM: a baseUrl already ending in /v1 probes /v1/models, not /v1/v1/models", async () => {
    const httpGetJson = vi.fn().mockResolvedValue({
      data: [{ id: "qwen36", max_model_len: 262144 }],
    });
    const r = new ContextWindowResolver({ loadRegistry, httpGetJson });
    const out = await r.resolve(
      {
        id: "v",
        providerType: "OpenAI",
        baseUrl: "http://localhost:8000/v1",
        apiKey: "x",
      },
      "qwen36",
    );
    expect(out.contextWindow).toBe(262144);
    expect(out.source).toBe("api");
    expect(httpGetJson).toHaveBeenCalledWith(
      "http://localhost:8000/v1/models",
      expect.anything(),
    );
  });

  it("official OpenAI (no baseUrl) skips the probe and falls to registry", async () => {
    const httpGetJson = vi.fn();
    const r = new ContextWindowResolver({ loadRegistry, httpGetJson });
    const out = await r.resolve({ ...openai, baseUrl: null }, "gpt-4o");
    expect(httpGetJson).not.toHaveBeenCalled();
    expect(out.source).toBe("registry");
  });

  it("a failing API probe falls through to the registry", async () => {
    const httpGetJson = vi.fn().mockRejectedValue(new Error("boom"));
    const r = new ContextWindowResolver({ loadRegistry, httpGetJson });
    const out = await r.resolve(
      { id: "g", providerType: "Google", baseUrl: "https://gen.example" },
      "gpt-4o",
    );
    expect(out.source).toBe("registry");
  });
});

describe("registry load failure (drift F3)", () => {
  it("a throwing loader degrades to empty registry → default, no reject", async () => {
    const r = new ContextWindowResolver({
      loadRegistry: async () => {
        throw new Error("bad vendored json");
      },
    });
    const out = await r.resolve({ ...openai }, "gpt-4o");
    expect(out.source).toBe("default");
    expect(out.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe("cache + evict (drift T5)", () => {
  it("caches within the TTL (one probe), evict forces a re-probe", async () => {
    const httpGetJson = vi
      .fn()
      .mockResolvedValue({ data: [{ id: "m", max_model_len: 1000 }] });
    const r = new ContextWindowResolver({ loadRegistry, httpGetJson });
    const p = {
      id: "v",
      providerType: "OpenAI",
      baseUrl: "http://x",
      apiKey: "k",
    };

    await r.resolve(p, "m");
    await r.resolve(p, "m");
    expect(httpGetJson).toHaveBeenCalledTimes(1); // second hit served from cache

    r.evict("v");
    await r.resolve(p, "m");
    expect(httpGetJson).toHaveBeenCalledTimes(2); // evict busted the cache
  });

  it("the cached value expires after the TTL", async () => {
    let now = 1000;
    const httpGetJson = vi
      .fn()
      .mockResolvedValue({ data: [{ id: "m", max_model_len: 1000 }] });
    const r = new ContextWindowResolver({
      loadRegistry,
      httpGetJson,
      ttlMs: 100,
      now: () => now,
    });
    const p = {
      id: "v",
      providerType: "OpenAI",
      baseUrl: "http://x",
      apiKey: "k",
    };

    await r.resolve(p, "m");
    now += 50;
    await r.resolve(p, "m");
    expect(httpGetJson).toHaveBeenCalledTimes(1); // still within TTL

    now += 100; // past TTL
    await r.resolve(p, "m");
    expect(httpGetJson).toHaveBeenCalledTimes(2);
  });

  it("RV7d: a default-source result is cached briefly, not for the full TTL", async () => {
    let now = 0;
    // API probe never yields a window and the model is not in the registry →
    // every resolve falls to source:"default".
    const httpGetJson = vi.fn().mockResolvedValue({ data: [] });
    const r = new ContextWindowResolver({
      loadRegistry,
      httpGetJson,
      ttlMs: 60 * 60 * 1000, // full TTL is an hour
      now: () => now,
    });
    const p = {
      id: "v",
      providerType: "OpenAI",
      baseUrl: "http://x",
      apiKey: "k",
    };

    const first = await r.resolve(p, "unknown-model");
    expect(first.source).toBe("default");

    now += 30 * 1000; // within the 60 s default-source TTL
    await r.resolve(p, "unknown-model");
    expect(httpGetJson).toHaveBeenCalledTimes(1); // still cached

    now += 40 * 1000; // 70 s total — past the short TTL, far short of the hour
    await r.resolve(p, "unknown-model");
    expect(httpGetJson).toHaveBeenCalledTimes(2); // re-probed, blip not pinned
  });
});
