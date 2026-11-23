import { and, eq, sql } from "drizzle-orm";
import { db, type Executor } from "../index.ts";
import {
  agent as agentTable,
  chat as chatTable,
  provider as providerTable,
} from "../db/schema.ts";
import { MODEL_ALIAS_PREFIX, type AliasRepoint } from "@platypus/schemas";
import { logger } from "../logger.ts";
import type { ProviderRow } from "./provider-write.ts";

type OrphanedAlias = Pick<AliasRepoint, "alias" | "modelId">;

type StoredModels = ProviderRow["modelIds"];

const aliasEntries = (
  models: StoredModels,
): Array<{ alias: string; id: string }> =>
  models.flatMap((entry) =>
    !entry.alias || !entry.id ? [] : [{ alias: entry.alias, id: entry.id }],
  );

export const orphanedAliasRepoints = (
  previous: StoredModels,
  next: StoredModels,
): OrphanedAlias[] => {
  const survivingNames = new Set(
    aliasEntries(next).map((entry) => entry.alias.toLowerCase()),
  );
  const survivingIds = new Set(next.map((entry) => entry.id));

  return aliasEntries(previous).flatMap(({ alias, id }) =>
    survivingNames.has(alias.toLowerCase()) || !survivingIds.has(id)
      ? []
      : [{ alias, modelId: id }],
  );
};

export const currentProviderModels = async (
  providerId: string,
  exec: Executor = db,
): Promise<StoredModels | null> => {
  const [row] = await exec
    .select({ modelIds: providerTable.modelIds })
    .from(providerTable)
    .where(eq(providerTable.id, providerId))
    .limit(1);
  return row ? row.modelIds : null;
};

export const deMigrateOrphanedAliases = async (
  providerId: string,
  previous: StoredModels,
  next: StoredModels,
  exec: Executor = db,
): Promise<AliasRepoint[]> => {
  const repoints = orphanedAliasRepoints(previous, next);
  const results: AliasRepoint[] = [];

  for (const { alias, modelId } of repoints) {
    const reference = `${MODEL_ALIAS_PREFIX}${alias}`.toLowerCase();

    const agents = await exec
      .update(agentTable)
      .set({ modelId, updatedAt: new Date() })
      .where(
        and(
          eq(agentTable.providerId, providerId),
          sql`lower(${agentTable.modelId}) = ${reference}`,
        ),
      )
      .returning({ id: agentTable.id });

    const chats = await exec
      .update(chatTable)
      .set({ modelId, updatedAt: new Date() })
      .where(
        and(
          eq(chatTable.providerId, providerId),
          sql`lower(${chatTable.modelId}) = ${reference}`,
        ),
      )
      .returning({ id: chatTable.id });

    const fallbackAgents = await exec
      .update(agentTable)
      .set({ fallbackModelId: modelId, updatedAt: new Date() })
      .where(
        and(
          eq(agentTable.fallbackProviderId, providerId),
          sql`lower(${agentTable.fallbackModelId}) = ${reference}`,
        ),
      )
      .returning({ id: agentTable.id });

    results.push({
      alias,
      modelId,
      agents: agents.length + fallbackAgents.length,
      chats: chats.length,
    });
  }

  if (results.length > 0) {
    logger.info(
      { providerId, repoints: results },
      "Repointed Model alias references to concrete ids after alias removal",
    );
  }

  return results;
};
