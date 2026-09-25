import type { z } from "zod";
import type { SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { provider as providerTable } from "../db/schema.ts";
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
  orgScopedWhere,
  requireOrgScoped,
  requireSharedDeletable,
  requireWorkspaceMutable,
  workspaceScopedWhere,
} from "./scoped-resource.ts";

/**
 * The Provider write model: the five-step save ordering — dedupe model
 * configs, invalidate stale embeddings (BEFORE the write), snapshot the
 * current models (BEFORE the write, for the alias diff), write the row, then
 * de-migrate any alias the save orphaned (AFTER the write) — plus create and
 * delete. Both the Workspace route (`routes/provider.ts`) and the Organization
 * route (`routes/org-provider.ts`) are thin adapters over it; they used to
 * each carry a verbatim copy of the ordering and had already drifted (#605):
 * the Workspace copy checked the Provider existed before touching embeddings,
 * the Organization copy did not, discovering a missing row only when the
 * `UPDATE` matched nothing.
 *
 * Distinct from `services/provider.ts`, which is the vendor-SDK adapter
 * (`openProvider`) — an unrelated seam that happens to share a resource name.
 */

export type ProviderRow = typeof providerTable.$inferSelect;

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The fields a create carries — every field but the id and its scope. */
export type ProviderCreateFields = Omit<
  z.infer<typeof providerCreateSchema>,
  "organizationId" | "workspaceId"
>;

/** The fields an update carries — providerUpdateSchema replaces the form wholesale. */
export type ProviderUpdateFields = ProviderUpdateData;

export type ProviderUpdateResult = {
  row: ProviderRow;
  aliasRepoints: AliasRepoint[];
};

/**
 * Which scope a write targets — the Workspace surface (ADR-0006 delegation
 * applies, a Shared row is locked) or the Organization surface (admin-only,
 * writes a Shared row directly). The one write model answers both surfaces by
 * branching on this rather than existing twice.
 */
export type ProviderScope =
  | { kind: "workspace"; ctx: ScopeContext }
  | { kind: "organization"; orgId: string };

/** Dedupes `modelIds` when the write carries any; passes through otherwise. */
const dedupeModels = <T extends { modelIds?: unknown }>(fields: T): T =>
  fields.modelIds
    ? {
        ...fields,
        modelIds: dedupeModelConfigs(
          fields.modelIds as Parameters<typeof dedupeModelConfigs>[0],
        ),
      }
    : fields;

/**
 * Creates a new Provider at the given scope. The scope comes from `scope`,
 * never the body — a caller cannot name another Workspace, or mint a Shared
 * Provider from the Workspace surface, by setting `organizationId`/
 * `workspaceId` in the request (ADR-0006, ADR-0007). A duplicate name
 * surfaces as a Postgres unique violation, mapped to 409 by the central
 * `onError` (ADR-0010).
 */
export async function createProvider(
  scope: ProviderScope,
  fields: ProviderCreateFields,
  // A transaction handle, when the create is one step of a larger write.
  exec: Executor = db,
): Promise<ProviderRow> {
  const data = dedupeModels(fields);

  const [row] = await exec
    .insert(providerTable)
    .values({
      id: nanoid(),
      ...data,
      ...(scope.kind === "workspace"
        ? { workspaceId: scope.ctx.workspaceId, organizationId: null }
        : { organizationId: scope.orgId, workspaceId: null }),
    })
    .returning();
  return row;
}

/**
 * Updates a Provider at the given scope, running the five-step save ordering.
 * Throws `NotFoundError` when the Provider is not visible at this scope, and
 * (Workspace scope only) `LockedError` when it is a Shared Provider edited
 * only on the Organization surface (ADR-0007).
 */
export async function updateProvider(
  scope: ProviderScope,
  providerId: string,
  fields: ProviderUpdateFields,
): Promise<ProviderUpdateResult> {
  const data = dedupeModels(fields);

  let where: SQL;
  if (scope.kind === "workspace") {
    // A Shared Provider is a single source of truth edited only on the
    // Organization surface (ADR-0007); requireWorkspaceMutable throws
    // NotFound (→404) when the Provider is not visible here, then Locked
    // (→403) when it is org-scoped.
    await requireWorkspaceMutable(db, "provider", providerId, scope.ctx);
    where = workspaceScopedWhere("provider", providerId, scope.ctx.workspaceId);
  } else {
    // The existence check the Organization surface previously skipped
    // (#605): requireOrgScoped throws NotFound (→404) before the write ever
    // touches embeddings.
    await requireOrgScoped(db, "provider", providerId, scope.orgId);
    where = orgScopedWhere("provider", providerId, scope.orgId);
  }

  // Detect and handle embedding config changes before the update.
  await handleEmbeddingConfigChange(providerId, data);

  // Snapshot the models as stored, so an alias this save removes can
  // de-migrate its references rather than dangling them (ADR-0017).
  const previousModels = data.modelIds
    ? await currentProviderModels(providerId)
    : null;

  // A duplicate name surfaces as a Postgres unique violation, mapped to 409
  // by the central onError (ADR-0010).
  const [row] = await db
    .update(providerTable)
    .set({ ...data, updatedAt: new Date() })
    .where(where)
    .returning();

  // Runs AFTER the row is written: a failed update must not leave Agents
  // repointed for an alias that still exists.
  const aliasRepoints =
    previousModels && data.modelIds
      ? await deMigrateOrphanedAliases(
          providerId,
          previousModels,
          data.modelIds,
        )
      : [];

  return { row, aliasRepoints };
}

/**
 * Deletes a Provider at the given scope. Throws `NotFoundError` (Workspace
 * scope, via `requireWorkspaceMutable`; Organization scope, when the delete
 * matches no row) and, Workspace scope only, `LockedError` for a Shared
 * Provider (ADR-0007). Organization scope also throws `ConflictError` while
 * an Attachment or Blueprint still references the Provider (ADR-0007/0008).
 */
export async function deleteProvider(
  scope: ProviderScope,
  providerId: string,
): Promise<void> {
  let where: SQL;
  if (scope.kind === "workspace") {
    await requireWorkspaceMutable(db, "provider", providerId, scope.ctx);
    where = workspaceScopedWhere("provider", providerId, scope.ctx.workspaceId);
  } else {
    // A Shared resource cannot be deleted while anything still points at it —
    // an Attachment (ADR-0007) or a Blueprint (ADR-0008). Throws ConflictError
    // → 409 via the central onError (ADR-0010).
    await requireSharedDeletable(db, "provider", providerId);
    where = orgScopedWhere("provider", providerId, scope.orgId);
  }

  // Deleting removes every model this Provider defined, so any Workspace
  // whose memory embeddings were computed against it now points at a config
  // that no longer resolves. Run BEFORE the delete: `nullifyEmbeddingsForProvider`
  // finds affected Workspaces via `workspace.memoryEmbeddingProviderId`, which
  // the FK's `ON DELETE SET NULL` would otherwise have already cleared.
  //
  // Alias de-migration intentionally does NOT run here. De-migration rewrites
  // a reference to the concrete model id an alias pointed at (ADR-0017) — but
  // a delete removes every one of this Provider's models, so there is no
  // surviving concrete id for an orphaned alias to fall back to. That case is
  // exactly what an update that merely drops one alias exists to handle.
  await nullifyEmbeddingsForProvider(providerId);

  const result = await db.delete(providerTable).where(where).returning();

  // Workspace scope: requireWorkspaceMutable already established the row
  // exists, so the delete always matches. Organization scope: requireSharedDeletable
  // only checks referencing Attachments/Blueprints, not existence, so the
  // delete itself is where a missing Provider 404s.
  if (scope.kind === "organization" && result.length === 0) {
    throw new NotFoundError("Provider not found");
  }
}
