import { describe, it, expect, beforeEach, vi } from "vitest";

const {
  mockCreateOpenAI,
  mockCreateOpenRouter,
  mockCreateAmazonBedrock,
  mockCreateGoogleGenerativeAI,
  mockCreateAnthropic,
} = vi.hoisted(() => {
  const makeMock = () => {
    const instance: any = vi.fn((modelId: string) => ({
      modelId,
      _sentinel: true,
    }));
    instance.chat = vi.fn((modelId: string) => ({
      modelId,
      _sentinel: true,
      _mode: "chat",
    }));
    const creator = vi.fn(() => instance);
    return { creator, instance };
  };
  return {
    mockCreateOpenAI: makeMock(),
    mockCreateOpenRouter: makeMock(),
    mockCreateAmazonBedrock: makeMock(),
    mockCreateGoogleGenerativeAI: makeMock(),
    mockCreateAnthropic: makeMock(),
  };
});

vi.mock("@ai-sdk/openai", () => ({ createOpenAI: mockCreateOpenAI.creator }));
vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: mockCreateOpenRouter.creator,
}));
vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: mockCreateAmazonBedrock.creator,
}));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: mockCreateGoogleGenerativeAI.creator,
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: mockCreateAnthropic.creator,
}));

import { openProvider } from "./provider.ts";

const baseProvider = {
  id: "p1",
  name: "Test",
  organizationId: "org-1",
  workspaceId: "ws-1",
  providerType: "OpenAI" as const,
  modelIds: ["gpt-4"],
  apiKey: "sk-test",
  apiMode: "chat" as const,
  baseUrl: null,
  headers: null,
  organization: null,
  project: null,
  region: null,
  extraBody: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("openProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens an OpenAI SDK client with provider config", () => {
    openProvider(baseProvider).languageModel("gpt-4");
    expect(mockCreateOpenAI.creator).toHaveBeenCalledWith({
      baseURL: undefined,
      apiKey: "sk-test",
      headers: undefined,
      organization: undefined,
      project: undefined,
    });
  });

  it("dispatches OpenRouter to the OpenRouter SDK", () => {
    openProvider({
      ...baseProvider,
      providerType: "OpenRouter" as const,
    }).languageModel("openai/gpt-4");
    expect(mockCreateOpenRouter.creator).toHaveBeenCalled();
  });

  it("dispatches Bedrock to the Amazon Bedrock SDK", () => {
    openProvider({
      ...baseProvider,
      providerType: "Bedrock" as const,
    }).languageModel("anthropic.claude-v2");
    expect(mockCreateAmazonBedrock.creator).toHaveBeenCalled();
  });

  it("dispatches Google to the Google Generative AI SDK", () => {
    openProvider({
      ...baseProvider,
      providerType: "Google" as const,
    }).languageModel("gemini-pro");
    expect(mockCreateGoogleGenerativeAI.creator).toHaveBeenCalled();
  });

  it("dispatches Anthropic to the Anthropic SDK", () => {
    openProvider({
      ...baseProvider,
      providerType: "Anthropic" as const,
    }).languageModel("claude-3-opus-20240229");
    expect(mockCreateAnthropic.creator).toHaveBeenCalled();
  });

  it("throws for unknown provider type", () => {
    expect(() =>
      openProvider({ ...baseProvider, providerType: "Unknown" as any }),
    ).toThrow("Unrecognized provider type 'Unknown'");
  });

  it("omits embeddingModel for Anthropic (no embedding API)", () => {
    const opened = openProvider({
      ...baseProvider,
      providerType: "Anthropic" as const,
    });
    expect(opened.embeddingModel).toBeUndefined();
  });

  it("omits searchTools for Bedrock (no vendor-native search)", () => {
    const opened = openProvider({
      ...baseProvider,
      providerType: "Bedrock" as const,
    });
    expect(opened.searchTools).toBeUndefined();
  });

  it("exposes embeddingModel and searchTools for OpenAI", () => {
    const opened = openProvider(baseProvider);
    expect(typeof opened.embeddingModel).toBe("function");
    expect(typeof opened.searchTools).toBe("function");
  });
});
