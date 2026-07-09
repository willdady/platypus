import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import type { ProviderUpdateData } from "@platypus/schemas";

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  nullifyEmbeddingsForProvider,
  handleEmbeddingConfigChange,
} from "./embedding-invalidation.ts";

describe("nullifyEmbeddingsForProvider", () => {
  beforeEach(() => {
    resetMockDb();
  });

  it("executes an UPDATE that nullifies embeddings for the provider's workspaces", async () => {
    mockDb.execute.mockResolvedValue({ rowCount: 3 });

    await nullifyEmbeddingsForProvider("p1");

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
  });

  it("does not throw when no rows are affected", async () => {
    mockDb.execute.mockResolvedValue({ rowCount: 0 });

    await expect(nullifyEmbeddingsForProvider("p1")).resolves.toBeUndefined();
  });
});

describe("handleEmbeddingConfigChange", () => {
  beforeEach(() => {
    resetMockDb();
  });

  it("is a no-op when neither embedding field is in the update payload", async () => {
    await handleEmbeddingConfigChange("p1", {
      name: "renamed",
    } as ProviderUpdateData);

    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it("nullifies embeddings when embeddingModelId changes", async () => {
    mockDb.limit.mockResolvedValueOnce([
      { embeddingModelId: "old-model", embeddingDimensions: 1536 },
    ]);
    mockDb.execute.mockResolvedValue({ rowCount: 2 });

    await handleEmbeddingConfigChange("p1", {
      embeddingModelId: "new-model",
    } as ProviderUpdateData);

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
  });

  it("nullifies embeddings when embeddingDimensions changes", async () => {
    mockDb.limit.mockResolvedValueOnce([
      { embeddingModelId: "model", embeddingDimensions: 1536 },
    ]);
    mockDb.execute.mockResolvedValue({ rowCount: 1 });

    await handleEmbeddingConfigChange("p1", {
      embeddingDimensions: 3072,
    } as ProviderUpdateData);

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
  });

  it("does not nullify when values are unchanged", async () => {
    mockDb.limit.mockResolvedValueOnce([
      { embeddingModelId: "same-model", embeddingDimensions: 1536 },
    ]);

    await handleEmbeddingConfigChange("p1", {
      embeddingModelId: "same-model",
      embeddingDimensions: 1536,
    } as ProviderUpdateData);

    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it("returns silently when the provider does not exist", async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    await handleEmbeddingConfigChange("p1", {
      embeddingModelId: "new",
    } as ProviderUpdateData);

    expect(mockDb.execute).not.toHaveBeenCalled();
  });
});
