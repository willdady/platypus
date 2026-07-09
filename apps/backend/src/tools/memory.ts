import { tool, type Tool } from "ai";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../index.ts";
import {
  memoryDailySummary as memoryDailySummaryTable,
  workspace as workspaceTable,
  provider as providerTable,
} from "../db/schema.ts";
import { generateEmbedding } from "../services/embedding.ts";
import type { Provider } from "@platypus/schemas";
import { logger } from "../logger.ts";

export const createMemoryTools = (
  workspaceId: string,
  userId: string,
): Record<string, Tool> => {
  // Cache embedding config for the lifetime of this tool set (one chat session)
  let cachedEmbeddingProvider: typeof providerTable.$inferSelect | null = null;
  let embeddingConfigLoaded = false;

  const loadEmbeddingConfig = async () => {
    if (embeddingConfigLoaded) return cachedEmbeddingProvider;
    embeddingConfigLoaded = true;

    const [ws] = await db
      .select({
        memoryEmbeddingProviderId: workspaceTable.memoryEmbeddingProviderId,
      })
      .from(workspaceTable)
      .where(eq(workspaceTable.id, workspaceId))
      .limit(1);

    if (!ws?.memoryEmbeddingProviderId) return null;

    const [provider] = await db
      .select()
      .from(providerTable)
      .where(eq(providerTable.id, ws.memoryEmbeddingProviderId))
      .limit(1);

    cachedEmbeddingProvider = provider?.embeddingModelId ? provider : null;
    return cachedEmbeddingProvider;
  };

  const memorySearch = tool({
    description:
      "Search past conversation memories by semantic similarity. Returns the most relevant daily summaries matching the query.",
    inputSchema: z.object({
      query: z.string().describe("The search query to find relevant memories"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe("Maximum number of results to return (1-20, default 5)"),
    }),
    execute: async ({ query, limit }) => {
      try {
        const embeddingProvider = await loadEmbeddingConfig();

        if (!embeddingProvider?.embeddingModelId) {
          return {
            error:
              "Memory search is not available — no embedding provider configured for this workspace.",
          };
        }

        // Generate query embedding
        const queryEmbedding = await generateEmbedding(
          embeddingProvider as Provider,
          embeddingProvider.embeddingModelId,
          query,
        );

        // Cosine similarity search using pgvector <=> operator
        const results = await db.execute(sql`
          SELECT
            id,
            summary_date,
            summary,
            1 - (embedding <=> ${JSON.stringify(queryEmbedding)}::vector) as relevance
          FROM memory_daily_summary
          WHERE user_id = ${userId}
            AND workspace_id = ${workspaceId}
            AND embedding IS NOT NULL
          ORDER BY embedding <=> ${JSON.stringify(queryEmbedding)}::vector
          LIMIT ${limit}
        `);

        const rows = results.rows as Array<{
          summary_date: string;
          summary: string;
          relevance: number;
        }>;
        return {
          results: rows.map((row) => ({
            date: row.summary_date,
            summary: row.summary,
            relevance: Math.round(Number(row.relevance) * 1000) / 1000,
          })),
        };
      } catch (error) {
        logger.error({ error }, "memorySearch tool failed");
        const message = error instanceof Error ? error.message : String(error);
        return { error: `Memory search failed: ${message}` };
      }
    },
  });

  const memoryGet = tool({
    description:
      "Get the daily memory summary for a specific date. Returns the full summary text for that day.",
    inputSchema: z.object({
      date: z
        .string()
        .describe("The date to retrieve the summary for (YYYY-MM-DD format)"),
    }),
    execute: async ({ date }) => {
      try {
        const [result] = await db
          .select()
          .from(memoryDailySummaryTable)
          .where(
            and(
              eq(memoryDailySummaryTable.userId, userId),
              eq(memoryDailySummaryTable.workspaceId, workspaceId),
              eq(memoryDailySummaryTable.summaryDate, date),
            ),
          )
          .limit(1);

        if (!result) {
          return { error: `No memory summary found for date ${date}` };
        }

        return {
          date: result.summaryDate,
          summary: result.summary,
        };
      } catch (error) {
        logger.error({ error }, "memoryGet tool failed");
        const message = error instanceof Error ? error.message : String(error);
        return { error: `Memory get failed: ${message}` };
      }
    },
  });

  return { memorySearch, memoryGet };
};
