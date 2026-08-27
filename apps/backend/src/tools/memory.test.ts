import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";
import { callTool, mockDb, resetMockDb } from "../test-utils.ts";

// The embedding call is the tool's one outbound dependency; mocking it keeps
// these tests off a real provider. Its own behaviour is the embedding
// service's to cover — what matters here is which provider and model id
// memorySearch hands it, and what it does when the call rejects.
vi.mock("../services/embedding.ts", () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createMemoryTools } from "./memory.ts";
import { generateEmbedding } from "../services/embedding.ts";
import { logger } from "../logger.ts";

const mockGenerateEmbedding = vi.mocked(generateEmbedding);

const workspaceId = "ws-1";
const userId = "user-1";

const EMBEDDING_PROVIDER = {
  id: "prov-1",
  providerType: "openai",
  embeddingModelId: "text-embedding-3-small",
};

/**
 * Stubs the two lookups `loadEmbeddingConfig` makes — the Workspace's
 * configured embedding provider id, then the Provider row itself. Passing
 * `null` leaves the Workspace unconfigured, which short-circuits before the
 * second query.
 */
const mockEmbeddingConfig = (
  provider: Record<string, unknown> | null = EMBEDDING_PROVIDER,
) => {
  mockDb.limit.mockResolvedValueOnce([
    { memoryEmbeddingProviderId: provider ? provider.id : null },
  ]);
  if (provider) mockDb.limit.mockResolvedValueOnce([provider]);
};

const NOT_CONFIGURED =
  "Memory search is not available — no embedding provider configured for this workspace.";

describe("createMemoryTools", () => {
  let tools: ReturnType<typeof createMemoryTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    tools = createMemoryTools(workspaceId, userId);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual(["memorySearch", "memoryGet"]);
  });

  describe("memorySearch input schema", () => {
    const schema = () =>
      tools.memorySearch.inputSchema as unknown as z.ZodType<{
        query: string;
        limit: number;
      }>;

    it("defaults limit to 5", () => {
      expect(schema().parse({ query: "standups" })).toEqual({
        query: "standups",
        limit: 5,
      });
    });

    it("bounds limit to 1-20", () => {
      expect(schema().safeParse({ query: "x", limit: 0 }).success).toBe(false);
      expect(schema().safeParse({ query: "x", limit: 21 }).success).toBe(false);
      expect(schema().safeParse({ query: "x", limit: 20 }).success).toBe(true);
    });

    it("rejects a non-integer limit", () => {
      expect(schema().safeParse({ query: "x", limit: 2.5 }).success).toBe(
        false,
      );
    });
  });

  describe("memorySearch", () => {
    it("returns an error when the workspace has no embedding provider", async () => {
      mockEmbeddingConfig(null);

      expect(
        await callTool(tools.memorySearch, { query: "x", limit: 5 }),
      ).toEqual({ error: NOT_CONFIGURED });
      expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    });

    it("returns an error when the workspace row is missing", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      expect(
        await callTool(tools.memorySearch, { query: "x", limit: 5 }),
      ).toEqual({ error: NOT_CONFIGURED });
    });

    it("returns an error when the configured provider has no embedding model", async () => {
      mockEmbeddingConfig({ ...EMBEDDING_PROVIDER, embeddingModelId: null });

      expect(
        await callTool(tools.memorySearch, { query: "x", limit: 5 }),
      ).toEqual({ error: NOT_CONFIGURED });
      expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    });

    it("embeds the query with the workspace's provider and model", async () => {
      mockEmbeddingConfig();
      mockDb.execute.mockResolvedValueOnce({ rows: [] });

      await callTool(tools.memorySearch, { query: "meeting notes", limit: 5 });

      expect(mockGenerateEmbedding).toHaveBeenCalledWith(
        EMBEDDING_PROVIDER,
        "text-embedding-3-small",
        "meeting notes",
      );
    });

    it("maps matched rows to date, summary and relevance", async () => {
      mockEmbeddingConfig();
      mockDb.execute.mockResolvedValueOnce({
        rows: [
          {
            summary_date: "2026-08-01",
            summary: "Shipped the plugin API",
            relevance: 0.87654321,
          },
          {
            summary_date: "2026-07-30",
            summary: "Reviewed the cascade contract",
            relevance: 0.5,
          },
        ],
      });

      expect(
        await callTool(tools.memorySearch, { query: "plugins", limit: 5 }),
      ).toEqual({
        results: [
          {
            date: "2026-08-01",
            summary: "Shipped the plugin API",
            relevance: 0.877,
          },
          {
            date: "2026-07-30",
            summary: "Reviewed the cascade contract",
            relevance: 0.5,
          },
        ],
      });
    });

    // pgvector arithmetic comes back from node-postgres as a string; the tool
    // coerces before rounding, so a string relevance must not become NaN.
    it("coerces a string relevance from the driver", async () => {
      mockEmbeddingConfig();
      mockDb.execute.mockResolvedValueOnce({
        rows: [
          {
            summary_date: "2026-08-01",
            summary: "Notes",
            relevance: "0.4567" as unknown as number,
          },
        ],
      });

      expect(
        await callTool(tools.memorySearch, { query: "notes", limit: 5 }),
      ).toEqual({
        results: [{ date: "2026-08-01", summary: "Notes", relevance: 0.457 }],
      });
    });

    it("loads the embedding config once per tool set", async () => {
      mockEmbeddingConfig();
      mockDb.execute.mockResolvedValue({ rows: [] });

      await callTool(tools.memorySearch, { query: "first", limit: 5 });
      await callTool(tools.memorySearch, { query: "second", limit: 5 });

      // Two selects total — the workspace and the provider — not four.
      expect(mockDb.select).toHaveBeenCalledTimes(2);
      expect(mockGenerateEmbedding).toHaveBeenCalledTimes(2);
    });

    it("caches a missing configuration too", async () => {
      mockEmbeddingConfig(null);

      await callTool(tools.memorySearch, { query: "first", limit: 5 });
      await callTool(tools.memorySearch, { query: "second", limit: 5 });

      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });

    it("returns an error and logs when the search query fails", async () => {
      mockEmbeddingConfig();
      mockDb.execute.mockRejectedValueOnce(new Error("relation is missing"));

      expect(
        await callTool(tools.memorySearch, { query: "x", limit: 5 }),
      ).toEqual({ error: "Memory search failed: relation is missing" });
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) as unknown }),
        "memorySearch tool failed",
      );
    });

    it("stringifies a non-Error rejection", async () => {
      mockEmbeddingConfig();
      mockGenerateEmbedding.mockRejectedValueOnce("provider exploded");

      expect(
        await callTool(tools.memorySearch, { query: "x", limit: 5 }),
      ).toEqual({ error: "Memory search failed: provider exploded" });
    });
  });

  describe("memoryGet", () => {
    it("returns the summary for a date", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { summaryDate: "2026-08-01", summary: "Shipped the plugin API" },
      ]);

      expect(await callTool(tools.memoryGet, { date: "2026-08-01" })).toEqual({
        date: "2026-08-01",
        summary: "Shipped the plugin API",
      });
    });

    it("returns an error when there is no summary for that date", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      expect(await callTool(tools.memoryGet, { date: "2026-08-02" })).toEqual({
        error: "No memory summary found for date 2026-08-02",
      });
    });

    it("returns an error and logs when the lookup throws", async () => {
      mockDb.limit.mockRejectedValueOnce(new Error("connection reset"));

      expect(await callTool(tools.memoryGet, { date: "2026-08-01" })).toEqual({
        error: "Memory get failed: connection reset",
      });
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) as unknown }),
        "memoryGet tool failed",
      );
    });

    it("stringifies a non-Error rejection", async () => {
      mockDb.limit.mockRejectedValueOnce("boom");

      expect(await callTool(tools.memoryGet, { date: "2026-08-01" })).toEqual({
        error: "Memory get failed: boom",
      });
    });
  });
});
