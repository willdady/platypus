import type { z } from "zod";
import { nanoid } from "nanoid";
import { and, eq, inArray } from "drizzle-orm";
import { db, type Tx } from "../index.ts";
import {
  blueprint as blueprintTable,
  blueprintItem as blueprintItemTable,
} from "../db/schema.ts";
import type { blueprintCreateSchema, BlueprintItem } from "@platypus/schemas";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  isUniqueViolation,
} from "../errors.ts";
import {
  applyBlueprintsToWorkspace,
  type ApplyBlueprintsResult,
} from "./blueprint-apply.ts";
import { requireWorkspaceInOrg } from "./attachment.ts";
import { isBlueprintReferencedByLiveInvitation } from "./blueprint-guard.ts";
import { requireMemoryProviderCapable } from "./memory-provider-validation.ts";
import {
  listOrgScopedIds,
  type ScopedResourceType,
} from "./scoped-resource.ts";

export type BlueprintRow = typeof blueprintTable.$inferSelect;

export type BlueprintFields = z.infer<typeof blueprintCreateSchema>;

export type BlueprintWithItems = BlueprintRow & { items: BlueprintItem[] };

const NAME_CONFLICT =
  "A blueprint with this name already exists in this organization";

const dedupeItems = (items: BlueprintItem[]): BlueprintItem[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.resourceType}:${item.resourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

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

const columnsOf = (fields: BlueprintFields) => ({
  name: fields.name,
  description: fields.description ?? null,
  taskModelProviderId: fields.taskModelProviderId ?? null,
  memoryExtractionProviderId: fields.memoryExtractionProviderId ?? null,
  memoryEmbeddingProviderId: fields.memoryEmbeddingProviderId ?? null,
  context: fields.context ?? null,
});

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
  if (!record) throw new NotFoundError("Blueprint not found");
  return { ...record, items };
};

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

export const getBlueprint = async (
  blueprintId: string,
  orgId: string,
): Promise<BlueprintWithItems> => {
  const record = await requireBlueprint(blueprintId, orgId);
  const itemsByBlueprint = await loadItemsByBlueprint([blueprintId]);
  return { ...record, items: itemsByBlueprint.get(blueprintId) ?? [] };
};

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
    await tx
      .delete(blueprintItemTable)
      .where(eq(blueprintItemTable.blueprintId, blueprintId));
  });
};

export const deleteBlueprint = async (
  blueprintId: string,
  orgId: string,
): Promise<void> => {
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

export const applyBlueprint = async (
  blueprintId: string,
  orgId: string,
  workspaceId: string,
): Promise<ApplyBlueprintsResult> => {
  await requireBlueprint(blueprintId, orgId);
  await requireWorkspaceInOrg(orgId, workspaceId);
  return db.transaction((tx) =>
    applyBlueprintsToWorkspace(tx, workspaceId, [blueprintId]),
  );
};
