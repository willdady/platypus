import { describe, it, expect } from "vitest";
import type { Agent, Provider } from "@platypus/schemas";
import { resolveModel } from "./resolve-model";

const provider = (over: Partial<Provider> = {}): Provider =>
  ({
    id: "p1",
    name: "Test",
    providerType: "Anthropic",
    apiMode: "chat",
    searchSource: "native",
    modelIds: [
      {
        id: "gpt-4",
        alias: "flagship",
        passthroughFileTypes: ["image/*"],
        contextWindow: 128_000,
        maxOutputTokens: 8_192,
      },
    ],
    ...over,
  }) as unknown as Provider;

const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: "a1",
    providerId: "p1",
    modelId: "alias:flagship",
    ...over,
  }) as unknown as Agent;

describe("resolveModel", () => {
  it("resolves a direct provider/model selection", () => {
    const p = provider();
    const resolved = resolveModel({
      providers: [p],
      agents: [],
      selection: { agentId: "", modelId: "alias:flagship", providerId: "p1" },
    });
    expect(resolved).toEqual({
      label: "flagship",
      concreteId: "gpt-4",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      passthroughFileTypes: ["image/*"],
      canSearch: true,
    });
  });

  it("resolves through an Agent's own provider and model", () => {
    const p = provider();
    const resolved = resolveModel({
      providers: [p],
      agents: [agent()],
      selection: { agentId: "a1", modelId: "", providerId: "" },
    });
    expect(resolved?.concreteId).toBe("gpt-4");
    expect(resolved?.label).toBe("flagship");
  });

  it("returns null when nothing is selected yet", () => {
    expect(
      resolveModel({
        providers: [provider()],
        agents: [],
        selection: { agentId: "", modelId: "", providerId: "" },
      }),
    ).toBeNull();
  });

  it("returns null when the selected Agent no longer exists", () => {
    expect(
      resolveModel({
        providers: [provider()],
        agents: [],
        selection: { agentId: "ghost", modelId: "", providerId: "" },
      }),
    ).toBeNull();
  });

  it("returns null when the selected Provider no longer exists", () => {
    expect(
      resolveModel({
        providers: [],
        agents: [],
        selection: { agentId: "", modelId: "gpt-4", providerId: "ghost" },
      }),
    ).toBeNull();
  });

  it("returns null when the model reference resolves to nothing (dangling id)", () => {
    expect(
      resolveModel({
        providers: [provider()],
        agents: [],
        selection: { agentId: "", modelId: "removed-model", providerId: "p1" },
      }),
    ).toBeNull();
  });

  it("falls back to the concrete id as the label when the model has no alias", () => {
    const p = provider({
      modelIds: [{ id: "gpt-4o-mini", passthroughFileTypes: [] }],
    });
    const resolved = resolveModel({
      providers: [p],
      agents: [],
      selection: { agentId: "", modelId: "gpt-4o-mini", providerId: "p1" },
    });
    expect(resolved?.label).toBe("gpt-4o-mini");
  });

  it("leaves contextWindow and maxOutputTokens undefined when undeclared", () => {
    const p = provider({
      modelIds: [{ id: "gpt-4o-mini", passthroughFileTypes: [] }],
    });
    const resolved = resolveModel({
      providers: [p],
      agents: [],
      selection: { agentId: "", modelId: "gpt-4o-mini", providerId: "p1" },
    });
    expect(resolved?.contextWindow).toBeUndefined();
    expect(resolved?.maxOutputTokens).toBeUndefined();
  });

  it("resolves canSearch false when the Provider's searchSource is none", () => {
    const p = provider({ searchSource: "none" });
    const resolved = resolveModel({
      providers: [p],
      agents: [],
      selection: { agentId: "", modelId: "alias:flagship", providerId: "p1" },
    });
    expect(resolved?.canSearch).toBe(false);
  });

  it("falls back to the provider's default passthrough types when the model declares none", () => {
    const p = provider({
      providerType: "Anthropic" as Provider["providerType"],
      modelIds: [{ id: "claude", passthroughFileTypes: [] }],
    });
    const resolved = resolveModel({
      providers: [p],
      agents: [],
      selection: { agentId: "", modelId: "claude", providerId: "p1" },
    });
    expect(resolved?.passthroughFileTypes).toEqual([
      "image/*",
      "application/pdf",
    ]);
  });
});
