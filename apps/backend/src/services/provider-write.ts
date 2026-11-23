import type { z } from "zod";
import { eq, or, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, type Executor } from "../index.ts";
import {
  agent as agentTable,
  provider as providerTable,
} from "../db/schema.ts";
import type {
  providerCreateSchema,
  ProviderUpdateData,
  AliasRepoint,
} from "@platypus/schemas";
import type { ScopeContext } from "../scope.ts";
import { NotFoundError } from "../errors.ts";
import { dedupeModelConfigs } from "./model-capability.ts";
import {
  handleEmbeddingConfigChange,
  nullifyEmbeddingsForProvider,
} from "./embedding-invalidation.ts";
import {
  currentProviderModels,
  deMigrateOrphanedAliases,
} from "./model-alias-migration.ts";
import {
  inUseConflict,
  orgScopedWhere,
  requireOrgScoped,
  requireSharedDeletable,
  requireWorkspaceMutable,
  workspaceScopedWhere,
} from "./scoped-resource.ts";
import { oneRow } from "../db/one-row.ts";

export type ProviderRow = typeof providerTable.$inferSelect;

export type ProviderCreateFields = z.infer<typeof providerCreateSchema>;

export type ProviderUpdateFields = ProviderUpdateData;

export type ProviderUpdateResult = {
  row: ProviderRow;
  aliasRepoints: AliasRepoint[];
};

export type ProviderScope =
  | { kind: "workspace"; ctx: ScopeContext }
  | { kind: "organization"; orgId: string };

const dedupeModels = <T extends { modelIds: ProviderRow["modelIds"] }>(
  fields: T,
): T => ({
  ...fields,
  modelIds: dedupeModelConfigs(fields.modelIds),
});

export async function createProvider(
  scope: ProviderScope,
  fields: ProviderCreateFields,
  exec: Executor,
): Promise<ProviderRow> {
  const data = dedupeModels(fields);

  const row = oneRow(
    await exec
      .insert(providerTable)
      .values({
        id: nanoid(),
        ...data,
        ...(scope.kind === "workspace"
          ? { workspaceId: scope.ctx.workspaceId, organizationId: null }
          : { organizationId: scope.orgId, workspaceId: null }),
      })
      .returning(),
  );
  return row;
}

export async function updateProvider(
  scope: ProviderScope,
  providerId: string,
  fields: ProviderUpdateFields,
): Promise<ProviderUpdateResult> {
  const data = dedupeModels(fields);

  return db.transaction(async (tx) => {
    let where: SQL;
    if (scope.kind === "workspace") {
      await requireWorkspaceMutable(tx, "provider", providerId, scope.ctx);
      where = workspaceScopedWhere(
        "provider",
        providerId,
        scope.ctx.workspaceId,
      );
    } else {
      await requireOrgScoped(tx, "provider", providerId, scope.orgId);
      where = orgScopedWhere("provider", providerId, scope.orgId);
    }

    await handleEmbeddingConfigChange(providerId, data, tx);

    const previousModels = await currentProviderModels(providerId, tx);

    const [row] = await tx
      .update(providerTable)
      .set({ ...data, updatedAt: new Date() })
      .where(where)
      .returning();
    if (!row) throw new NotFoundError("Provider not found");

    const aliasRepoints = previousModels
      ? await deMigrateOrphanedAliases(
          providerId,
          previousModels,
          data.modelIds,
          tx,
        )
      : [];

    return { row, aliasRepoints };
  });
}

async function requireNoAgents(
  providerId: string,
  exec: Executor,
): Promise<void> {
  const agents = await exec
    .select({ name: agentTable.name })
    .from(agentTable)
    .where(
      or(
        eq(agentTable.providerId, providerId),
        eq(agentTable.fallbackProviderId, providerId),
      ),
    );
  if (agents.length > 0) {
    throw inUseConflict(
      "provider",
      "agent",
      agents.map((a) => a.name),
    );
  }
}

export async function deleteProvider(
  scope: ProviderScope,
  providerId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    let where: SQL;
    if (scope.kind === "workspace") {
      await requireWorkspaceMutable(tx, "provider", providerId, scope.ctx);
      where = workspaceScopedWhere(
        "provider",
        providerId,
        scope.ctx.workspaceId,
      );
    } else {
      await requireSharedDeletable(tx, "provider", providerId);
      where = orgScopedWhere("provider", providerId, scope.orgId);
    }
    await requireNoAgents(providerId, tx);

    await nullifyEmbeddingsForProvider(providerId, tx);

    const result = await tx.delete(providerTable).where(where).returning();

    if (scope.kind === "organization" && result.length === 0) {
      throw new NotFoundError("Provider not found");
    }
  });
}
