import { describe, it, expect } from "vitest";
import type { Provider } from "@platypus/schemas";
import {
  defaultPassthroughFileTypes,
  resolveProviderModels,
  providerModelIds,
  providerHasModel,
  passthroughFileTypesForModel,
  dedupeModelConfigs,
} from "./model-capability.ts";

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

describe("providerModelIds / providerHasModel", () => {
  const p = provider({
    modelIds: [
      { id: "a", passthroughFileTypes: [] },
      { id: "b", passthroughFileTypes: [] },
    ],
  });
  it("lists ids in order", () => {
    expect(providerModelIds(p)).toEqual(["a", "b"]);
  });
  it("reports membership", () => {
    expect(providerHasModel(p, "b")).toBe(true);
    expect(providerHasModel(p, "z")).toBe(false);
  });
});

describe("passthroughFileTypesForModel", () => {
  it("returns the model's resolved types, defaulting when unknown", () => {
    const p = provider({
      providerType: "Anthropic",
      apiMode: "responses",
      modelIds: [{ id: "claude", passthroughFileTypes: ["image/*"] }],
    });
    expect(passthroughFileTypesForModel(p, "claude")).toEqual(["image/*"]);
    // Unknown model → provider default.
    expect(passthroughFileTypesForModel(p, "ghost")).toEqual([
      "image/*",
      "application/pdf",
    ]);
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
