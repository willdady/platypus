import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";
import { callTool, mockDb, resetMockDb, seedDb } from "../test-utils.ts";

// The embedding call is the tool's one outbound dependency; mocking it keeps
// these tests off a real provider. Its own behaviour is the embedding
// service's to cover — what matters here is which provider and model id
// memorySearch hands it, and what it does when the call rejects.
vi.mock("../services/embedding.ts", () => ({
  generateEmbedding: vi.fn(),
}));

import { createMemoryTools } from "./memory.ts";
import { generateEmbedding } from "../services/embedding.ts";
import { logger } from "../logger.ts";

const mockGenerateEmbedding = vi.mocked(generateEmbedding);

const workspaceId = "ws-1";
const userId = "user-1";

const EMBEDDING_PROVIDER = {
  id: "prov-1",
  organizationId: null,
  workspaceId,
  providerType: "openai",
  embeddingModelId: "text-embedding-3-small",
};

/**
 * Stubs the lookups the factory makes — the Workspace's configured embedding
 * provider id, then the Provider row itself (a Shared one is then checked for
 * an Attachment, queued by the test). Passing `null` leaves the Workspace
 * unconfigured, which short-circuits before the second query.
 */
const mockEmbeddingConfig = (
  provider: Record<string, unknown> | null = EMBEDDING_PROVIDER,
) => {
  mockDb.limit.mockResolvedValueOnce([
    {
      organizationId: "org-1",
      memoryEmbeddingProviderId: provider ? provider.id : null,
    },
  ]);
  if (provider) mockDb.limit.mockResolvedValueOnce([provider]);
};

const createTools = () => createMemoryTools(workspaceId, userId);

describe("createMemoryTools", () => {
  let tools: Awaited<ReturnType<typeof createMemoryTools>>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it("offers memorySearch and memoryGet when the workspace has an embedding provider", async () => {
    mockEmbeddingConfig();

    expect(Object.keys(await createTools())).toEqual([
      "memorySearch",
      "memoryGet",
    ]);
  });

  // Issue #1059: without an embedding provider memorySearch could only return
  // an error, so the model is not offered it.
  describe("without a usable embedding provider, offers only memoryGet", () => {
    it("when none is configured", async () => {
      mockEmbeddingConfig(null);

      expect(Object.keys(await createTools())).toEqual(["memoryGet"]);
    });

    it("when the workspace row is missing", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      expect(Object.keys(await createTools())).toEqual(["memoryGet"]);
    });

    it("when the configured provider has no embedding model", async () => {
      mockEmbeddingConfig({ ...EMBEDDING_PROVIDER, embeddingModelId: null });

      expect(Object.keys(await createTools())).toEqual(["memoryGet"]);
    });

    it("when the Shared embedding provider is not attached", async () => {
      mockEmbeddingConfig({
        ...EMBEDDING_PROVIDER,
        organizationId: "org-1",
        workspaceId: null,
      });
      mockDb.limit.mockResolvedValueOnce([]); // no Attachment

      expect(Object.keys(await createTools())).toEqual(["memoryGet"]);
    });
  });

  describe("memorySearch input schema", () => {
    beforeEach(async () => {
      mockEmbeddingConfig();
      tools = await createTools();
    });

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
    beforeEach(async () => {
      mockEmbeddingConfig();
      tools = await createTools();
    });

    it("embeds the query with the workspace's provider and model", async () => {
      mockDb.execute.mockResolvedValueOnce({ rows: [] });

      await callTool(tools.memorySearch, { query: "meeting notes", limit: 5 });

      expect(mockGenerateEmbedding).toHaveBeenCalledWith(
        EMBEDDING_PROVIDER,
        "text-embedding-3-small",
        "meeting notes",
      );
    });

    it("searches only this user's memories in this workspace, up to the limit", async () => {
      mockDb.execute.mockResolvedValueOnce({ rows: [] });

      await callTool(tools.memorySearch, { query: "x", limit: 7 });

      // The raw SQL reaches `execute` as the test-utils `sql` marker: the
      // template's literal strings, and the values bound between them.
      const { strings, values } = mockDb.execute.mock.calls[0][0] as {
        strings: string[];
        values: unknown[];
      };
      const boundAfter = (fragment: RegExp) =>
        values[strings.findIndex((part) => fragment.test(part))];
      expect(boundAfter(/user_id =\s*$/)).toBe(userId);
      expect(boundAfter(/workspace_id =\s*$/)).toBe(workspaceId);
      expect(boundAfter(/LIMIT\s*$/)).toBe(7);
    });

    it("maps matched rows to date, summary and relevance", async () => {
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
      mockDb.execute.mockResolvedValue({ rows: [] });

      await callTool(tools.memorySearch, { query: "first", limit: 5 });
      await callTool(tools.memorySearch, { query: "second", limit: 5 });

      // Two selects total — the workspace and the provider — not four.
      expect(mockDb.select).toHaveBeenCalledTimes(2);
      expect(mockGenerateEmbedding).toHaveBeenCalledTimes(2);
    });

    it("returns an error and logs when the search query fails", async () => {
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
      mockGenerateEmbedding.mockRejectedValueOnce("provider exploded");

      expect(
        await callTool(tools.memorySearch, { query: "x", limit: 5 }),
      ).toEqual({ error: "Memory search failed: provider exploded" });
    });
  });

  describe("memoryGet", () => {
    const summary = (over: Record<string, unknown>) => ({
      id: `m-${String(over.summary)}`,
      userId,
      workspaceId,
      summaryDate: "2026-08-01",
      ...over,
    });

    it("returns this user's summary for a date in this workspace", async () => {
      seedDb({
        memory_daily_summary: [
          summary({ userId: "user-2", summary: "Another user's day" }),
          summary({ workspaceId: "ws-2", summary: "Another workspace's day" }),
          summary({ summaryDate: "2026-07-31", summary: "The day before" }),
          summary({ summary: "Shipped the plugin API" }),
        ],
      });
      tools = await createTools();

      expect(await callTool(tools.memoryGet, { date: "2026-08-01" })).toEqual({
        date: "2026-08-01",
        summary: "Shipped the plugin API",
      });
    });

    it("does not return another user's or workspace's summary for that date", async () => {
      seedDb({
        memory_daily_summary: [
          summary({ userId: "user-2", summary: "Another user's day" }),
          summary({ workspaceId: "ws-2", summary: "Another workspace's day" }),
        ],
      });
      tools = await createTools();

      expect(await callTool(tools.memoryGet, { date: "2026-08-01" })).toEqual({
        error: "No memory summary found for date 2026-08-01",
      });
    });

    it("returns an error and logs when the lookup throws", async () => {
      mockEmbeddingConfig(null);
      tools = await createTools();
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
      mockEmbeddingConfig(null);
      tools = await createTools();
      mockDb.limit.mockRejectedValueOnce("boom");

      expect(await callTool(tools.memoryGet, { date: "2026-08-01" })).toEqual({
        error: "Memory get failed: boom",
      });
    });
  });
});
