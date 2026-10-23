import { and, eq, sql } from "drizzle-orm";
import { db, type Tx } from "../index.ts";
import {
  agent as agentTable,
  chat as chatTable,
  provider as providerTable,
} from "../db/schema.ts";
import {
  MODEL_ALIAS_PREFIX,
  type AliasRepoint,
  type ModelConfig,
} from "@platypus/schemas";
import { logger } from "../logger.ts";

/**
 * De-migration: rewriting `alias:<name>` references back to a concrete id when
 * the alias they name stops existing (issue #386, ADR-0017).
 *
 * A Model alias has no identity apart from its name, so "renaming" one is
 * indistinguishable from deleting it and creating another. Left alone, that
 * would hard-fail every Agent and Chat pointing at the old name — across every
 * attached Workspace for a Shared Provider — and the Org Admin who renamed it
 * would find out only when turns start failing. Rewriting the references to the
 * concrete id the alias pointed at keeps each one running against the exact
 * model it was already using.
 *
 * This is the one place a Provider edit bulk-rewrites Agents and Chats. It is
 * justified here and NOT for alias creation, where doing nothing is harmless:
 * adding an alias changes no entry's `id`, so every existing reference keeps
 * resolving and a rewrite would be cosmetic. Here, doing nothing breaks turns.
 */

/** An orphaned alias and the concrete id its references fall back to. */
type OrphanedAlias = Pick<AliasRepoint, "alias" | "modelId">;

/** Tolerates the legacy bare-`string[]` shape on either side of the diff. */
const aliasEntries = (
  models: ModelConfig[],
): Array<{ alias: string; id: string }> =>
  (models as unknown as Array<string | Partial<ModelConfig>>).flatMap(
    (entry) =>
      typeof entry === "string" || !entry.alias || !entry.id
        ? []
        : [{ alias: entry.alias, id: entry.id }],
  );

/**
 * The aliases that existed before this save and no longer exist after it,
 * paired with the concrete id each one pointed at.
 *
 * Covers rename, clearing the field, and deleting a model entry that carried an
 * alias as one case, because all three are "this name is gone". Names compare
 * case-insensitively, matching how a reference resolves — so re-casing an alias
 * orphans nothing, and neither does moving the same name to a different entry
 * (that is a repoint, which is the whole point of aliases).
 *
 * An alias whose model entry disappeared in the SAME save is skipped: there is
 * no concrete id left to fall back to, so its references stay dangling, exactly
 * as a deleted model's concrete references always have.
 */
export const orphanedAliasRepoints = (
  previous: ModelConfig[],
  next: ModelConfig[],
): OrphanedAlias[] => {
  const survivingNames = new Set(
    aliasEntries(next).map((entry) => entry.alias.toLowerCase()),
  );
  const survivingIds = new Set(
    (next as unknown as Array<string | Partial<ModelConfig>>).map((entry) =>
      typeof entry === "string" ? entry : (entry.id ?? ""),
    ),
  );

  return aliasEntries(previous).flatMap(({ alias, id }) =>
    survivingNames.has(alias.toLowerCase()) || !survivingIds.has(id)
      ? []
      : [{ alias, modelId: id }],
  );
};

/**
 * The Provider's models as currently stored, for diffing against an incoming
 * save. Read BEFORE the update; `null` when the Provider does not exist.
 */
export const currentProviderModels = async (
  providerId: string,
  exec: typeof db | Tx = db,
): Promise<ModelConfig[] | null> => {
  const [row] = await exec
    .select({ modelIds: providerTable.modelIds })
    .from(providerTable)
    .where(eq(providerTable.id, providerId))
    .limit(1);
  return row ? (row.modelIds as unknown as ModelConfig[]) : null;
};

/**
 * Rewrite every `agent.modelId` / `chat.modelId` on this Provider that names an
 * orphaned alias back to the concrete id, and report how many of each moved.
 *
 * Matches references case-insensitively because resolution is case-insensitive:
 * a stored `alias:FLAGSHIP` resolves to the alias `flagship`, so it has to
 * de-migrate with it or it would be left dangling.
 *
 * Call AFTER the provider row is written — a failed provider update must not
 * leave Agents rewritten for an alias that still exists.
 */
export const deMigrateOrphanedAliases = async (
  providerId: string,
  previous: ModelConfig[],
  next: ModelConfig[],
  exec: typeof db | Tx = db,
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

    results.push({
      alias,
      modelId,
      agents: agents.length,
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
