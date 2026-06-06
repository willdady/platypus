import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  blueprint as blueprintTable,
  blueprintItem as blueprintItemTable,
  attachment as attachmentTable,
  agent as agentTable,
  mcp as mcpTable,
  provider as providerTable,
  skill as skillTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import {
  blueprintCreateSchema,
  blueprintUpdateSchema,
  blueprintApplySchema,
  type BlueprintItem,
} from "@platypus/schemas";
import { and, eq, inArray } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess } from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

// Blueprint — a named, Organization-scoped macro that, applied to a Workspace,
// creates the Attachments for a chosen set of Shared resources in one step
// (ADR-0008). It is a snapshot, not a living binding: applying stamps
// Attachments at that moment; later edits never disturb already-provisioned
// Workspaces. A Blueprint may only list org-scoped (Shared) resources, and all
// management — and applying — is Org-Admin-only.
const orgBlueprint = new Hono<{ Variables: Variables }>();

const RESOURCE_TABLES = {
  mcp: mcpTable,
  provider: providerTable,
  skill: skillTable,
  agent: agentTable,
} as const;

type ResourceType = keyof typeof RESOURCE_TABLES;

/** Detects a Postgres unique-constraint violation across driver shapes. */
const isUniqueViolation = (error: any): boolean =>
  error.code === "23505" ||
  error.cause?.code === "23505" ||
  error.message?.includes("unique constraint") ||
  error.cause?.message?.includes("unique constraint");

const NAME_CONFLICT = {
  error: "A blueprint with this name already exists in this organization",
} as const;

/** Drop duplicate items (same resourceType + resourceId). */
const dedupeItems = (items: BlueprintItem[]): BlueprintItem[] => {
  const seen = new Set<string>();
  const out: BlueprintItem[] = [];
  for (const item of items) {
    const key = `${item.resourceType}:${item.resourceId}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
};

/**
 * Returns the subset of `items` that do NOT resolve to an org-scoped resource
 * in this organization. A Blueprint may only list Shared resources (ADR-0008),
 * so any workspace-private or foreign-org reference is a blocker.
 */
const findNonSharedItems = async (
  items: BlueprintItem[],
  orgId: string,
): Promise<BlueprintItem[]> => {
  const byType = new Map<ResourceType, string[]>();
  for (const item of items) {
    const ids = byType.get(item.resourceType as ResourceType) ?? [];
    ids.push(item.resourceId);
    byType.set(item.resourceType as ResourceType, ids);
  }

  const invalid: BlueprintItem[] = [];
  for (const [resourceType, ids] of byType) {
    const table = RESOURCE_TABLES[resourceType];
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.organizationId, orgId), inArray(table.id, ids)));
    const found = new Set(rows.map((r) => r.id));
    for (const id of ids) {
      if (!found.has(id)) invalid.push({ resourceType, resourceId: id });
    }
  }
  return invalid;
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

/** Create a Blueprint (admin only) */
orgBlueprint.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", blueprintCreateSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const { name, description, items } = c.req.valid("json");
    const deduped = dedupeItems(items);

    const invalid = await findNonSharedItems(deduped, orgId);
    if (invalid.length > 0) {
      return c.json(
        {
          error:
            "A blueprint may only list organization-scoped (Shared) resources",
          invalidItems: invalid,
        },
        422,
      );
    }

    const id = nanoid();
    try {
      await db.transaction(async (tx) => {
        await tx.insert(blueprintTable).values({
          id,
          organizationId: orgId,
          name,
          description: description ?? null,
        });
        if (deduped.length > 0) {
          await tx.insert(blueprintItemTable).values(
            deduped.map((item) => ({
              id: nanoid(),
              blueprintId: id,
              resourceType: item.resourceType,
              resourceId: item.resourceId,
            })),
          );
        }
      });
    } catch (error: any) {
      if (isUniqueViolation(error)) {
        return c.json(NAME_CONFLICT, 409);
      }
      throw error;
    }

    const [record] = await db
      .select()
      .from(blueprintTable)
      .where(eq(blueprintTable.id, id))
      .limit(1);
    return c.json({ ...record, items: deduped }, 201);
  },
);

/** List Blueprints, each with its items (admin only) */
orgBlueprint.get("/", requireAuth, requireOrgAccess(["admin"]), async (c) => {
  const orgId = c.req.param("orgId")!;
  const blueprints = await db
    .select()
    .from(blueprintTable)
    .where(eq(blueprintTable.organizationId, orgId));

  const itemsByBlueprint = await loadItemsByBlueprint(
    blueprints.map((b) => b.id),
  );
  const results = blueprints.map((b) => ({
    ...b,
    items: itemsByBlueprint.get(b.id) ?? [],
  }));
  return c.json({ results });
});

/** Get a Blueprint by ID, with its items (admin only) */
orgBlueprint.get(
  "/:blueprintId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const blueprintId = c.req.param("blueprintId");
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
    if (!record) {
      return c.json({ error: "Blueprint not found" }, 404);
    }
    const itemsByBlueprint = await loadItemsByBlueprint([blueprintId]);
    return c.json({
      ...record,
      items: itemsByBlueprint.get(blueprintId) ?? [],
    });
  },
);

/** Update a Blueprint by ID (admin only) — replaces its item set */
orgBlueprint.put(
  "/:blueprintId",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", blueprintUpdateSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const blueprintId = c.req.param("blueprintId");
    const { name, description, items } = c.req.valid("json");
    const deduped = dedupeItems(items);

    // The blueprint must exist in this org before we touch its items.
    const [existing] = await db
      .select({ id: blueprintTable.id })
      .from(blueprintTable)
      .where(
        and(
          eq(blueprintTable.id, blueprintId),
          eq(blueprintTable.organizationId, orgId),
        ),
      )
      .limit(1);
    if (!existing) {
      return c.json({ error: "Blueprint not found" }, 404);
    }

    const invalid = await findNonSharedItems(deduped, orgId);
    if (invalid.length > 0) {
      return c.json(
        {
          error:
            "A blueprint may only list organization-scoped (Shared) resources",
          invalidItems: invalid,
        },
        422,
      );
    }

    try {
      await db.transaction(async (tx) => {
        await tx
          .update(blueprintTable)
          .set({
            name,
            description: description ?? null,
            updatedAt: new Date(),
          })
          .where(eq(blueprintTable.id, blueprintId));
        // Snapshot semantics: replacing the item set never touches already
        // provisioned Workspaces — those Attachments stand on their own.
        await tx
          .delete(blueprintItemTable)
          .where(eq(blueprintItemTable.blueprintId, blueprintId));
        if (deduped.length > 0) {
          await tx.insert(blueprintItemTable).values(
            deduped.map((item) => ({
              id: nanoid(),
              blueprintId,
              resourceType: item.resourceType,
              resourceId: item.resourceId,
            })),
          );
        }
      });
    } catch (error: any) {
      if (isUniqueViolation(error)) {
        return c.json(NAME_CONFLICT, 409);
      }
      throw error;
    }

    const [record] = await db
      .select()
      .from(blueprintTable)
      .where(eq(blueprintTable.id, blueprintId))
      .limit(1);
    return c.json({ ...record, items: deduped }, 200);
  },
);

/** Delete a Blueprint by ID (admin only) — items cascade */
orgBlueprint.delete(
  "/:blueprintId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const blueprintId = c.req.param("blueprintId");
    const result = await db
      .delete(blueprintTable)
      .where(
        and(
          eq(blueprintTable.id, blueprintId),
          eq(blueprintTable.organizationId, orgId),
        ),
      )
      .returning();
    if (result.length === 0) {
      return c.json({ error: "Blueprint not found" }, 404);
    }
    return c.json({ message: "Blueprint deleted" });
  },
);

/**
 * Apply a Blueprint to an existing Workspace (admin only). The macro creates the
 * Attachments for the Blueprint's current items. It is additive and idempotent:
 * re-applying, or applying a resource already attached, is a no-op (ADR-0008).
 */
orgBlueprint.post(
  "/:blueprintId/apply",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", blueprintApplySchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const blueprintId = c.req.param("blueprintId");
    const { workspaceId } = c.req.valid("json");

    const [record] = await db
      .select({ id: blueprintTable.id })
      .from(blueprintTable)
      .where(
        and(
          eq(blueprintTable.id, blueprintId),
          eq(blueprintTable.organizationId, orgId),
        ),
      )
      .limit(1);
    if (!record) {
      return c.json({ error: "Blueprint not found" }, 404);
    }

    // The target workspace must belong to this organization.
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
    if (!ws) {
      return c.json({ error: "Workspace not found in this organization" }, 404);
    }

    const itemsByBlueprint = await loadItemsByBlueprint([blueprintId]);
    const items = itemsByBlueprint.get(blueprintId) ?? [];

    if (items.length === 0) {
      return c.json({ workspaceId, attached: 0, skipped: 0, total: 0 }, 200);
    }

    // Additive + idempotent: onConflictDoNothing against the unique
    // (workspace, type, id) attachment constraint, so re-runs only add what is
    // missing. `returning()` yields just the rows actually inserted.
    const inserted = await db
      .insert(attachmentTable)
      .values(
        items.map((item) => ({
          id: nanoid(),
          workspaceId,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
        })),
      )
      .onConflictDoNothing()
      .returning();

    const attached = inserted.length;
    return c.json(
      {
        workspaceId,
        attached,
        skipped: items.length - attached,
        total: items.length,
      },
      200,
    );
  },
);

export { orgBlueprint };
