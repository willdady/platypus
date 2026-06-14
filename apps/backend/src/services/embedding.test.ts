import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Provider } from "@platypus/schemas";

const { mockEmbed, mockOpenProvider } = vi.hoisted(() => ({
  mockEmbed: vi.fn(),
  mockOpenProvider: vi.fn(),
}));

vi.mock("ai", () => ({ embed: mockEmbed }));
vi.mock("./provider.ts", () => ({ openProvider: mockOpenProvider }));

import { generateEmbedding } from "./embedding.ts";

const baseProvider: Provider = {
  id: "p1",
  name: "Test",
  organizationId: "org-1",
  workspaceId: "ws-1",
  providerType: "OpenAI",
  modelIds: ["text-embedding-3-small"],
  apiKey: "sk-test",
  apiMode: "chat",
  nativeSearchEnabled: true,
  taskModelId: "text-embedding-3-small",
  memoryExtractionModelId: "text-embedding-3-small",
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("generateEmbedding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the embedding vector from the provider", async () => {
    const embeddingModelFn = vi.fn((id: string) => ({ modelId: id }));
    mockOpenProvider.mockReturnValue({ embeddingModel: embeddingModelFn });
    mockEmbed.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });

    const result = await generateEmbedding(
      baseProvider,
      "text-embedding-3-small",
      "hello world",
    );

    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(embeddingModelFn).toHaveBeenCalledWith("text-embedding-3-small");
    expect(mockEmbed).toHaveBeenCalledWith({
      model: { modelId: "text-embedding-3-small" },
      value: "hello world",
    });
  });

  it("throws when the provider does not support embeddings", async () => {
    mockOpenProvider.mockReturnValue({ embeddingModel: undefined });

    await expect(
      generateEmbedding(
        { ...baseProvider, providerType: "Anthropic" },
        "model",
        "text",
      ),
    ).rejects.toThrow(
      "Provider type 'Anthropic' does not support text embeddings.",
    );
    expect(mockEmbed).not.toHaveBeenCalled();
  });
});
