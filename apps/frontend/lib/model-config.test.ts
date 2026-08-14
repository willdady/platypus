import { describe, it, expect } from "vitest";
import type { ConcreteModelId, Provider } from "@platypus/schemas";
import {
  getModelConfigs,
  getModelOptions,
  findModelOption,
  resolveModelId,
  getPassthroughFileTypes,
  getContextWindow,
} from "./model-config";

const provider = (modelIds: unknown, over: Partial<Provider> = {}) =>
  ({
    id: "p1",
    name: "Test",
    workspaceId: "ws-1",
    providerType: "OpenAI",
    apiKey: "sk",
    apiMode: "chat",
    nativeSearchEnabled: true,
    modelIds,
    taskModelId: "gpt-4",
    memoryExtractionModelId: "gpt-4",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as unknown as Provider;

const aliased = provider([
  { id: "gpt-4", passthroughFileTypes: [], alias: "flagship" },
  { id: "gpt-4o-mini", passthroughFileTypes: [] },
]);

describe("getModelConfigs", () => {
  it("carries the alias through", () => {
    expect(getModelConfigs(aliased)[0].alias).toBe("flagship");
  });

  it("leaves a legacy string[] entry with no alias", () => {
    expect(getModelConfigs(provider(["gpt-4"]))[0]).toEqual({
      id: "gpt-4",
      passthroughFileTypes: [],
    });
  });

  it("carries a declared maxOutputTokens through", () => {
    const configs = getModelConfigs(
      provider([
        { id: "gpt-4", passthroughFileTypes: [], maxOutputTokens: 64000 },
      ]),
    );
    expect(configs[0].maxOutputTokens).toBe(64000);
  });

  it("leaves maxOutputTokens undefined for an undeclared or legacy entry", () => {
    expect(
      getModelConfigs(provider([{ id: "gpt-4", passthroughFileTypes: [] }]))[0]
        .maxOutputTokens,
    ).toBeUndefined();
    expect(
      getModelConfigs(provider(["gpt-4"]))[0].maxOutputTokens,
    ).toBeUndefined();
  });
});

describe("getModelOptions", () => {
  it("splits label from value for an aliased model", () => {
    expect(getModelOptions(aliased)).toEqual([
      { value: "alias:flagship", label: "flagship" },
      { value: "gpt-4o-mini", label: "gpt-4o-mini" },
    ]);
  });

  it("never shows the storage prefix as a label", () => {
    for (const option of getModelOptions(aliased)) {
      expect(option.label).not.toContain("alias:");
    }
  });
});

describe("findModelOption", () => {
  it("selects the aliased entry for an Agent still storing the bare id", () => {
    // The regression this exists for: without entry-based matching the Agent
    // form renders its placeholder over a correctly-configured Agent.
    expect(findModelOption(aliased, "gpt-4")).toEqual({
      value: "alias:flagship",
      label: "flagship",
    });
  });

  it("selects the same entry for an alias reference", () => {
    expect(findModelOption(aliased, "alias:flagship")).toEqual({
      value: "alias:flagship",
      label: "flagship",
    });
  });

  it("selects an un-aliased entry by id", () => {
    expect(findModelOption(aliased, "gpt-4o-mini")).toEqual({
      value: "gpt-4o-mini",
      label: "gpt-4o-mini",
    });
  });

  it("returns undefined when the model is genuinely gone", () => {
    expect(findModelOption(aliased, "gpt-3.5")).toBeUndefined();
    expect(findModelOption(aliased, "alias:ghost")).toBeUndefined();
  });
});

describe("resolveModelId", () => {
  it("resolves a reference to the concrete id", () => {
    expect(resolveModelId(aliased, "alias:flagship")).toBe("gpt-4");
    expect(resolveModelId(aliased, "gpt-4")).toBe("gpt-4");
    expect(resolveModelId(aliased, "alias:ghost")).toBeUndefined();
  });
});

describe("getPassthroughFileTypes", () => {
  it("uses an aliased model's declared types, not the provider default", () => {
    const p = provider(
      [{ id: "qwen-vl", passthroughFileTypes: ["image/*"], alias: "vision" }],
      { providerType: "OpenRouter" as Provider["providerType"] },
    );
    const resolved = resolveModelId(p, "alias:vision")!;
    expect(getPassthroughFileTypes(p, resolved)).toEqual(["image/*"]);
  });

  it("falls back to the provider default when the model declares none", () => {
    const p = provider([
      { id: "gpt-4", passthroughFileTypes: [], alias: "flagship" },
    ]);
    const resolved = resolveModelId(p, "alias:flagship")!;
    expect(getPassthroughFileTypes(p, resolved)).toEqual(["image/*"]);
  });
});

describe("getContextWindow", () => {
  it("returns the declared window for an aliased model", () => {
    // The window lives on the model ENTRY, so repointing an alias moves it —
    // no special handling required (ADR-0017 + ADR-0018).
    const p = provider([
      {
        id: "claude-sonnet",
        passthroughFileTypes: [],
        alias: "flagship",
        contextWindow: 200_000,
      },
    ]);
    const resolved = resolveModelId(p, "alias:flagship")!;
    expect(getContextWindow(p, resolved)).toBe(200_000);
  });

  it("returns undefined when undeclared, unknown, or on a legacy list", () => {
    const declaredNone = provider([{ id: "gpt-4", passthroughFileTypes: [] }]);
    expect(
      getContextWindow(declaredNone, resolveModelId(declaredNone, "gpt-4")!),
    ).toBeUndefined();
    expect(
      getContextWindow(declaredNone, "ghost" as ConcreteModelId),
    ).toBeUndefined();

    const legacy = provider(["legacy-model"]);
    expect(
      getContextWindow(legacy, resolveModelId(legacy, "legacy-model")!),
    ).toBeUndefined();
  });
});
