import { eq, sql } from "drizzle-orm";
import { db, type Executor } from "../index.ts";
import { provider as providerTable } from "../db/schema.ts";
import { logger } from "../logger.ts";
import type { ProviderUpdateData } from "@platypus/schemas";

/**
 * Nullifies all embeddings in workspaces that use the given provider for
 * memory embeddings. Called when a provider's embedding model or dimensions
 * change so that stale/incompatible embeddings are not used for search.
 */
export async function nullifyEmbeddingsForProvider(
  providerId: string,
  exec: Executor = db,
): Promise<void> {
  const result = await exec.execute(sql`
    UPDATE memory_daily_summary
    SET embedding = NULL, updated_at = NOW()
    WHERE workspace_id IN (
      SELECT id FROM workspace WHERE memory_embedding_provider_id = ${providerId}
    )
    AND embedding IS NOT NULL
  `);

  if (result.rowCount && result.rowCount > 0) {
    logger.info(
      { providerId, rowCount: result.rowCount },
      "Nullified memory embeddings due to provider embedding config change",
    );
  }
}

/**
 * Detects whether an update payload changes the embedding configuration
 * of a provider, and if so, nullifies stale embeddings.
 */
export async function handleEmbeddingConfigChange(
  providerId: string,
  data: ProviderUpdateData,
  exec: Executor = db,
): Promise<void> {
  if (
    data.embeddingModelId === undefined &&
    data.embeddingDimensions === undefined
  ) {
    return;
  }

  const [existing] = await exec
    .select({
      embeddingModelId: providerTable.embeddingModelId,
      embeddingDimensions: providerTable.embeddingDimensions,
    })
    .from(providerTable)
    .where(eq(providerTable.id, providerId))
    .limit(1);

  if (!existing) return;

  const changed =
    (data.embeddingModelId !== undefined &&
      data.embeddingModelId !== existing.embeddingModelId) ||
    (data.embeddingDimensions !== undefined &&
      data.embeddingDimensions !== existing.embeddingDimensions);

  if (changed) {
    await nullifyEmbeddingsForProvider(providerId, exec);
  }
}
