import type { z } from "zod";
import { nanoid } from "nanoid";
import { and, eq, inArray } from "drizzle-orm";
import { db, type Tx } from "../index.ts";
import {
  blueprint as blueprintTable,
  blueprintItem as blueprintItemTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import type { blueprintCreateSchema, BlueprintItem } from "@platypus/schemas";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  isUniqueViolation,
} from "../errors.ts";
import { applyBlueprintsToWorkspace } from "./blueprint-apply.ts";
import { isBlueprintReferencedByLiveInvitation } from "./blueprint-guard.ts";
import { requireMemoryProviderCapable } from "./memory-provider-validation.ts";
import {
  listOrgScopedIds,
  type ScopedResourceType,
} from "./scoped-resource.ts";

/**
 * The Blueprint write model behind `routes/org-blueprint.ts`. A Blueprint is a
 * named, Organization-scoped macro that, applied to a Workspace, creates the
 * Attachments for a chosen set of Shared resources in one step (ADR-0008). It
 * is a snapshot, not a living binding: applying stamps Attachments at that
 * moment; later edits never disturb already-provisioned Workspaces. A
 * Blueprint may only list org-scoped (Shared) resources. Failures throw the
 * typed errors mapped centrally by `app.onError` (ADR-0010).
 */

export type BlueprintRow = typeof blueprintTable.$inferSelect;

/** The fields a create or update carries — both replace the form wholesale. */
export type BlueprintFields = z.infer<typeof blueprintCreateSchema>;

export type BlueprintWithItems = BlueprintRow & { items: BlueprintItem[] };

const NAME_CONFLICT =
  "A blueprint with this name already exists in this organization";

/** Drop duplicate items (same resourceType + resourceId). */
const dedupeItems = (items: BlueprintItem[]): BlueprintItem[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.resourceType}:${item.resourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Throws `NotFoundError` naming every item that does NOT resolve to an
 * org-scoped resource in this organization. A Blueprint may only list Shared
 * resources (ADR-0008), so any workspace-private or foreign-org reference is a
 * blocker.
 */
const requireSharedItems = async (
  items: BlueprintItem[],
  orgId: string,
): Promise<void> => {
  const byType = new Map<ScopedResourceType, string[]>();
  for (const item of items) {
    const ids = byType.get(item.resourceType) ?? [];
    ids.push(item.resourceId);
    byType.set(item.resourceType, ids);
  }

  const invalid: string[] = [];
  for (const [resourceType, ids] of byType) {
    const found = await listOrgScopedIds(db, resourceType, ids, orgId);
    for (const id of ids) {
      if (!found.has(id)) invalid.push(`${resourceType} ${id}`);
    }
  }
  if (invalid.length > 0) {
    throw new NotFoundError(
      `Shared resources not found in this organization: ${invalid.join(", ")}`,
    );
  }
};

/**
 * Throws `ValidationError` naming each Tier 2 provider setting that points at a
 * Provider the Blueprint does NOT also attach. Applying a Blueprint both
 * attaches the provider and points the Workspace at it, so a pointer to an
 * unattached provider would leave the Workspace referencing something it can't
 * see. Because items are already validated org-scoped, "is an attached
 * provider item" also implies org-scoped (ADR-0008).
 */
const requireTier2ProvidersAttached = (
  fields: BlueprintFields,
  items: BlueprintItem[],
): void => {
  const attached = new Set(
    items.filter((i) => i.resourceType === "provider").map((i) => i.resourceId),
  );
  const unattached = [
    fields.taskModelProviderId,
    fields.memoryExtractionProviderId,
    fields.memoryEmbeddingProviderId,
  ].filter((id): id is string => !!id && !attached.has(id));
  if (unattached.length > 0) {
    throw new ValidationError(
      `A blueprint's provider settings must reference providers the blueprint also attaches: ${unattached.join(", ")}`,
    );
  }
};

/**
 * The one validation path create and update share: dedupes the items, then
 * throws unless every item is Shared in this Organization, every Tier 2
 * setting points at an attached Provider, and every memory Provider exposes the
 * model its slot needs (so apply never stamps an unusable memory config).
 * Returns the deduped items to persist.
 */
const validateFields = async (
  fields: BlueprintFields,
  orgId: string,
): Promise<BlueprintItem[]> => {
  const items = dedupeItems(fields.items);
  await requireSharedItems(items, orgId);
  requireTier2ProvidersAttached(fields, items);
  await requireMemoryProviderCapable(fields, { orgId });
  return items;
};

/** The Blueprint columns a create or update writes. */
const columnsOf = (fields: BlueprintFields) => ({
  name: fields.name,
  description: fields.description ?? null,
  taskModelProviderId: fields.taskModelProviderId ?? null,
  memoryExtractionProviderId: fields.memoryExtractionProviderId ?? null,
  memoryEmbeddingProviderId: fields.memoryEmbeddingProviderId ?? null,
  context: fields.context ?? null,
});

/**
 * Runs a Blueprint write in a transaction, writing `items` as its item set and
 * mapping a duplicate name to `ConflictError`.
 */
const writeBlueprint = async (
  blueprintId: string,
  items: BlueprintItem[],
  writeRow: (tx: Tx) => Promise<unknown>,
): Promise<BlueprintWithItems> => {
  try {
    await db.transaction(async (tx) => {
      await writeRow(tx);
      if (items.length > 0) {
        await tx.insert(blueprintItemTable).values(
          items.map((item) => ({
            id: nanoid(),
            blueprintId,
            resourceType: item.resourceType,
            resourceId: item.resourceId,
          })),
        );
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(NAME_CONFLICT);
    throw error;
  }

  const [record] = await db
    .select()
    .from(blueprintTable)
    .where(eq(blueprintTable.id, blueprintId))
    .limit(1);
  return { ...record, items };
};

/** Load the items of one or more blueprints, grouped by blueprint id. */
const loadItemsByBlueprint = async (
  blueprintIds: string[],
): Promise<Map<string, BlueprintItem[]>> => {
  const grouped = new Map<string, BlueprintItem[]>();
  if (blueprintIds.length === 0) return grouped;
  const rows = await db
    .select({
      blueprintId: blueprintItemTable.blueprintId,
      resourceType: blueprintItemTable.resourceType,
      resourceId: blueprintItemTable.resourceId,
    })
    .from(blueprintItemTable)
    .where(inArray(blueprintItemTable.blueprintId, blueprintIds));
  for (const row of rows) {
    const items = grouped.get(row.blueprintId) ?? [];
    items.push({ resourceType: row.resourceType, resourceId: row.resourceId });
    grouped.set(row.blueprintId, items);
  }
  return grouped;
};

/** The Blueprint `blueprintId` in this Organization, or `NotFoundError`. */
export const requireBlueprint = async (
  blueprintId: string,
  orgId: string,
): Promise<BlueprintRow> => {
  const [record] = await db
    .select()
    .from(blueprintTable)
    .where(
      and(
        eq(blueprintTable.id, blueprintId),
        eq(blueprintTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!record) throw new NotFoundError("Blueprint not found");
  return record;
};

/** Every Blueprint in this Organization, each with its items. */
export const listBlueprints = async (
  orgId: string,
): Promise<BlueprintWithItems[]> => {
  const blueprints = await db
    .select()
    .from(blueprintTable)
    .where(eq(blueprintTable.organizationId, orgId));
  const itemsByBlueprint = await loadItemsByBlueprint(
    blueprints.map((b) => b.id),
  );
  return blueprints.map((b) => ({
    ...b,
    items: itemsByBlueprint.get(b.id) ?? [],
  }));
};

/** One Blueprint with its items, or `NotFoundError`. */
export const getBlueprint = async (
  blueprintId: string,
  orgId: string,
): Promise<BlueprintWithItems> => {
  const record = await requireBlueprint(blueprintId, orgId);
  const itemsByBlueprint = await loadItemsByBlueprint([blueprintId]);
  return { ...record, items: itemsByBlueprint.get(blueprintId) ?? [] };
};

/** Creates a Blueprint and its item set. */
export const createBlueprint = async (
  orgId: string,
  fields: BlueprintFields,
): Promise<BlueprintWithItems> => {
  const items = await validateFields(fields, orgId);
  const id = nanoid();
  return writeBlueprint(id, items, (tx) =>
    tx
      .insert(blueprintTable)
      .values({ id, organizationId: orgId, ...columnsOf(fields) }),
  );
};

/** Updates a Blueprint, replacing its item set. */
export const updateBlueprint = async (
  blueprintId: string,
  orgId: string,
  fields: BlueprintFields,
): Promise<BlueprintWithItems> => {
  await requireBlueprint(blueprintId, orgId);
  const items = await validateFields(fields, orgId);
  return writeBlueprint(blueprintId, items, async (tx) => {
    await tx
      .update(blueprintTable)
      .set({ ...columnsOf(fields), updatedAt: new Date() })
      .where(eq(blueprintTable.id, blueprintId));
    // Snapshot semantics: replacing the item set never touches already
    // provisioned Workspaces — those Attachments stand on their own.
    await tx
      .delete(blueprintItemTable)
      .where(eq(blueprintItemTable.blueprintId, blueprintId));
  });
};

/** Deletes a Blueprint; its items cascade. */
export const deleteBlueprint = async (
  blueprintId: string,
  orgId: string,
): Promise<void> => {
  // A Blueprint cannot be deleted while a live pending invitation references
  // it (ADR-0009) — accept-time provisioning would otherwise dereference a
  // missing Blueprint. A lazily-expired invite does not block.
  if (await isBlueprintReferencedByLiveInvitation(blueprintId)) {
    throw new ConflictError(
      "Cannot delete: this blueprint is referenced by one or more pending invitations. Delete those invitations first.",
    );
  }
  const result = await db
    .delete(blueprintTable)
    .where(
      and(
        eq(blueprintTable.id, blueprintId),
        eq(blueprintTable.organizationId, orgId),
      ),
    )
    .returning();
  if (result.length === 0) throw new NotFoundError("Blueprint not found");
};

/**
 * Applies one Blueprint to a Workspace in this Organization. Tier 1
 * Attachments and Tier 2 settings commit together (ADR-0008).
 */
export const applyBlueprint = async (
  blueprintId: string,
  orgId: string,
  workspaceId: string,
) => {
  await requireBlueprint(blueprintId, orgId);
  const [ws] = await db
    .select({ id: workspaceTable.id })
    .from(workspaceTable)
    .where(
      and(
        eq(workspaceTable.id, workspaceId),
        eq(workspaceTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!ws) throw new NotFoundError("Workspace not found in this organization");
  return db.transaction((tx) =>
    applyBlueprintsToWorkspace(tx, workspaceId, [blueprintId]),
  );
};
