import { describe, it, expect } from "vitest";
import type { ConcreteModelId, Provider } from "@platypus/schemas";
import {
  defaultPassthroughFileTypes,
  resolveProviderModels,
  providerModelReferences,
  passthroughFileTypesForModel,
  maxExtractedTextCharsForModel,
  maxOutputTokensForModel,
  contextWindowForModel,
  dedupeModelConfigs,
  resolveModelId,
} from "./model-capability.ts";
import { DEFAULT_MAX_EXTRACTED_TEXT_CHARS } from "@platypus/schemas";

/**
 * Stand in for the resolver where a test deliberately probes a model the
 * provider does NOT have — `resolveModelId` returns undefined there by design,
 * so the defensive fallbacks can only be reached with a hand-made id.
 */
const concrete = (id: string) => id as ConcreteModelId;

const provider = (over: Partial<Provider>): Provider => ({
  id: "p1",
  name: "Test",
  workspaceId: "ws-1",
  providerType: "OpenAI",
  apiKey: "sk",
  apiMode: "chat",
  nativeSearchEnabled: true,
  modelIds: [{ id: "m", passthroughFileTypes: [] }],
  taskModelId: "m",
  memoryExtractionModelId: "m",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe("defaultPassthroughFileTypes", () => {
  it("gives native-file providers images + PDF", () => {
    for (const t of ["Anthropic", "Google", "Bedrock"] as const) {
      expect(
        defaultPassthroughFileTypes(provider({ providerType: t })),
      ).toEqual(["image/*", "application/pdf"]);
    }
  });

  it("gives OpenAI Responses images + PDF but chat-completions images only", () => {
    expect(
      defaultPassthroughFileTypes(
        provider({ providerType: "OpenAI", apiMode: "responses" }),
      ),
    ).toEqual(["image/*", "application/pdf"]);
    expect(
      defaultPassthroughFileTypes(
        provider({ providerType: "OpenAI", apiMode: "chat" }),
      ),
    ).toEqual(["image/*"]);
  });

  it("gives OpenRouter (heterogeneous aggregator) no native floor", () => {
    // Per-model capability varies too much for a single floor; an undeclared
    // model rejects binaries at the gate rather than forwarding an image a
    // text-only model can't read (#328).
    expect(
      defaultPassthroughFileTypes(provider({ providerType: "OpenRouter" })),
    ).toEqual([]);
  });
});

describe("resolveProviderModels", () => {
  it("coerces a legacy string[] to objects with provider-type defaults", () => {
    const p = provider({
      providerType: "Anthropic",
      apiMode: "responses",
      modelIds: ["claude-x", "claude-y"] as unknown as Provider["modelIds"],
    });
    expect(resolveProviderModels(p)).toEqual([
      { id: "claude-x", passthroughFileTypes: ["image/*", "application/pdf"] },
      { id: "claude-y", passthroughFileTypes: ["image/*", "application/pdf"] },
    ]);
  });

  it("fills the default when an object declares no passthrough types", () => {
    const p = provider({
      providerType: "OpenAI",
      apiMode: "chat",
      modelIds: [{ id: "qwen", passthroughFileTypes: [] }],
    });
    // Empty array is treated as "declare none" → inherit the provider default.
    expect(resolveProviderModels(p)[0].passthroughFileTypes).toEqual([
      "image/*",
    ]);
  });

  it("preserves an explicit passthrough declaration", () => {
    const p = provider({
      modelIds: [{ id: "qwen-vl", passthroughFileTypes: ["image/*"] }],
    });
    expect(resolveProviderModels(p)[0].passthroughFileTypes).toEqual([
      "image/*",
    ]);
  });

  it("leaves an undeclared OpenRouter model accepting nothing natively", () => {
    const p = provider({
      providerType: "OpenRouter",
      modelIds: [{ id: "llama-text", passthroughFileTypes: [] }],
    });
    // Empty inherits the OpenRouter floor, which is now empty — so a binary is
    // rejected at the gate until the operator declares the model vision-capable.
    expect(resolveProviderModels(p)[0].passthroughFileTypes).toEqual([]);
  });
});

describe("providerModelReferences", () => {
  it("lists ids in order", () => {
    const p = provider({
      modelIds: [
        { id: "a", passthroughFileTypes: [] },
        { id: "b", passthroughFileTypes: [] },
      ],
    });
    expect(providerModelReferences(p)).toEqual(["a", "b"]);
  });

  it("lists the alias reference for an aliased model", () => {
    // What the Agent picker submits: the concrete id of an aliased model is
    // deliberately not offered, so a repoint reaches every reference (#386).
    const p = provider({
      modelIds: [
        { id: "gpt-4", passthroughFileTypes: [], alias: "flagship" },
        { id: "gpt-4o-mini", passthroughFileTypes: [] },
      ],
    });
    expect(providerModelReferences(p)).toEqual([
      "alias:flagship",
      "gpt-4o-mini",
    ]);
  });

  it("lists ids for a legacy string[], which cannot carry aliases", () => {
    const p = provider({
      modelIds: ["a", "b"] as unknown as Provider["modelIds"],
    });
    expect(providerModelReferences(p)).toEqual(["a", "b"]);
  });
});

describe("passthroughFileTypesForModel", () => {
  it("returns the model's resolved types, defaulting when unknown", () => {
    const p = provider({
      providerType: "Anthropic",
      apiMode: "responses",
      modelIds: [{ id: "claude", passthroughFileTypes: ["image/*"] }],
    });
    expect(passthroughFileTypesForModel(p, concrete("claude"))).toEqual([
      "image/*",
    ]);
    // Unknown model → provider default.
    expect(passthroughFileTypesForModel(p, concrete("ghost"))).toEqual([
      "image/*",
      "application/pdf",
    ]);
  });
});

describe("maxExtractedTextCharsForModel", () => {
  it("returns the model's declared cap", () => {
    const p = provider({
      modelIds: [
        { id: "qwen", passthroughFileTypes: [], maxExtractedTextChars: 8000 },
      ],
    });
    expect(maxExtractedTextCharsForModel(p, concrete("qwen"))).toBe(8000);
  });

  it("falls back to the shared default when undeclared or unknown", () => {
    const p = provider({
      modelIds: [{ id: "qwen", passthroughFileTypes: [] }],
    });
    expect(maxExtractedTextCharsForModel(p, concrete("qwen"))).toBe(
      DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
    );
    expect(maxExtractedTextCharsForModel(p, concrete("ghost"))).toBe(
      DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
    );
  });

  it("survives a legacy string[] model list", () => {
    const p = provider({
      modelIds: ["legacy"] as unknown as Provider["modelIds"],
    });
    expect(maxExtractedTextCharsForModel(p, concrete("legacy"))).toBe(
      DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
    );
  });
});

describe("maxOutputTokensForModel", () => {
  it("returns the model's declared ceiling", () => {
    const p = provider({
      modelIds: [
        { id: "qwen", passthroughFileTypes: [], maxOutputTokens: 64000 },
      ],
    });
    expect(maxOutputTokensForModel(p, concrete("qwen"))).toBe(64000);
  });

  // Undefined rather than a default of our own: the whole point is that an
  // undeclared model behaves exactly as it did before the field existed, with
  // the provider SDK's own default left in place.
  it("returns undefined when undeclared or unknown", () => {
    const p = provider({
      modelIds: [{ id: "qwen", passthroughFileTypes: [] }],
    });
    expect(maxOutputTokensForModel(p, concrete("qwen"))).toBeUndefined();
    expect(maxOutputTokensForModel(p, concrete("ghost"))).toBeUndefined();
  });

  it("survives a legacy string[] model list", () => {
    const p = provider({
      modelIds: ["legacy"] as unknown as Provider["modelIds"],
    });
    expect(maxOutputTokensForModel(p, concrete("legacy"))).toBeUndefined();
  });
});

describe("contextWindowForModel", () => {
  it("returns the model's declared window", () => {
    const p = provider({
      modelIds: [
        { id: "qwen", passthroughFileTypes: [], contextWindow: 32_000 },
      ],
    });
    expect(contextWindowForModel(p, concrete("qwen"))).toBe(32_000);
  });

  it("returns undefined when undeclared or unknown", () => {
    const p = provider({
      modelIds: [{ id: "qwen", passthroughFileTypes: [] }],
    });
    // No default to fall back to: unlike the extracted-text cap, an undeclared
    // window has no safe substitute — inventing one is what ADR-0018 forbids.
    expect(contextWindowForModel(p, concrete("qwen"))).toBeUndefined();
    expect(contextWindowForModel(p, concrete("ghost"))).toBeUndefined();
  });

  it("survives a legacy string[] model list", () => {
    const p = provider({
      modelIds: ["legacy"] as unknown as Provider["modelIds"],
    });
    expect(contextWindowForModel(p, concrete("legacy"))).toBeUndefined();
  });

  it("reads each Provider's own declaration for the same model id", () => {
    const direct = provider({
      modelIds: [
        { id: "claude", passthroughFileTypes: [], contextWindow: 200_000 },
      ],
    });
    const proxied = provider({
      modelIds: [
        { id: "claude", passthroughFileTypes: [], contextWindow: 32_000 },
      ],
    });
    expect(contextWindowForModel(direct, concrete("claude"))).toBe(200_000);
    expect(contextWindowForModel(proxied, concrete("claude"))).toBe(32_000);
  });
});

describe("dedupeModelConfigs", () => {
  it("dedupes by id (first wins) and sorts by id", () => {
    expect(
      dedupeModelConfigs([
        { id: "b", passthroughFileTypes: ["image/*"] },
        { id: "a", passthroughFileTypes: [] },
        { id: "b", passthroughFileTypes: [] },
      ]),
    ).toEqual([
      { id: "a", passthroughFileTypes: [] },
      { id: "b", passthroughFileTypes: ["image/*"] },
    ]);
  });
});

describe("resolveModelId", () => {
  const p = provider({
    modelIds: [
      { id: "gpt-4", passthroughFileTypes: [], alias: "flagship" },
      { id: "gpt-4o-mini", passthroughFileTypes: [] },
    ],
  });

  it("resolves an alias reference to the concrete id it points at", () => {
    expect(resolveModelId(p, "alias:flagship")).toBe("gpt-4");
  });

  it("resolves an alias reference case-insensitively", () => {
    expect(resolveModelId(p, "alias:FLAGSHIP")).toBe("gpt-4");
  });

  it("passes a concrete id through, aliased or not", () => {
    expect(resolveModelId(p, "gpt-4")).toBe("gpt-4");
    expect(resolveModelId(p, "gpt-4o-mini")).toBe("gpt-4o-mini");
  });

  it("returns undefined rather than falling back to another model", () => {
    expect(resolveModelId(p, "alias:ghost")).toBeUndefined();
    expect(resolveModelId(p, "ghost")).toBeUndefined();
  });

  it("never resolves an alias reference to a like-named concrete id", () => {
    expect(resolveModelId(p, "alias:gpt-4o-mini")).toBeUndefined();
  });

  it("resolves against a legacy string[] model list", () => {
    const legacy = provider({
      modelIds: ["legacy"] as unknown as Provider["modelIds"],
    });
    expect(resolveModelId(legacy, "legacy")).toBe("legacy");
    expect(resolveModelId(legacy, "alias:legacy")).toBeUndefined();
  });

  it("carries the aliased model's own capabilities, not the provider default", () => {
    const aliased = provider({
      providerType: "OpenRouter",
      modelIds: [
        {
          id: "qwen-vl",
          passthroughFileTypes: ["image/*"],
          alias: "vision",
          maxExtractedTextChars: 8000,
        },
      ],
    });
    const resolved = resolveModelId(aliased, "alias:vision")!;
    expect(passthroughFileTypesForModel(aliased, resolved)).toEqual([
      "image/*",
    ]);
    expect(maxExtractedTextCharsForModel(aliased, resolved)).toBe(8000);
  });
});
