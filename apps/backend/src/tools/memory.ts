import { tool, type Tool } from "ai";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../index.ts";
import {
  memoryDailySummary as memoryDailySummaryTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { generateEmbedding } from "../services/embedding.ts";
import { resolveScoped } from "../services/scoped-resource.ts";
import { pointerSettingModelId } from "../services/model-capability.ts";
import type { Provider } from "@platypus/schemas";
import { logger } from "../logger.ts";

/**
 * The Workspace's embedding Provider with its embedding model, or null when
 * there is none to search with: nothing configured, a Shared Provider not
 * attached here, or a Provider with no embedding model.
 */
const loadEmbeddingConfig = async (workspaceId: string) => {
  const [ws] = await db
    .select({
      organizationId: workspaceTable.organizationId,
      memoryEmbeddingProviderId: workspaceTable.memoryEmbeddingProviderId,
    })
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);

  if (!ws?.memoryEmbeddingProviderId) return null;

  // A Shared Provider serves this Workspace only where attached (ADR-0007).
  const found = await resolveScoped(
    db,
    "provider",
    ws.memoryEmbeddingProviderId,
    { orgId: ws.organizationId, workspaceId },
  );
  const provider = found?.row;
  if (!provider?.embeddingModelId) return null;

  return { provider, modelId: provider.embeddingModelId };
};

export const createMemoryTools = async (
  workspaceId: string,
  userId: string,
): Promise<Record<string, Tool>> => {
  // Resolved once per turn. Without an embedding Provider memorySearch could
  // only return an error, so it is left out rather than offered (#1059), and
  // the system prompt, which reads the turn's tool map, stops naming it.
  const embedding = await loadEmbeddingConfig(workspaceId);

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

  if (!embedding) return { memoryGet };

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
        // Generate query embedding
        const queryEmbedding = await generateEmbedding(
          embedding.provider as Provider,
          pointerSettingModelId(embedding.modelId),
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

  return { memorySearch, memoryGet };
};
