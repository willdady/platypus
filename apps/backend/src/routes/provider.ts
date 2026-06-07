import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { provider as providerTable } from "../db/schema.ts";
import { providerCreateSchema, providerUpdateSchema } from "@platypus/schemas";
import { eq, and } from "drizzle-orm";
import { handleEmbeddingConfigChange } from "../services/embedding-invalidation.ts";
import { dedupeArray } from "../utils.ts";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess,
} from "../middleware/authorization.ts";
import {
  listScoped,
  requireScoped,
  requireWorkspaceMutable,
} from "../services/scoped-resource.ts";
import type { Variables } from "../server.ts";

const provider = new Hono<{ Variables: Variables }>();

/**
 * Create a workspace-scoped provider. Org-admin by default; a workspace owner
 * may create one only when the workspace's `providerSelfManagement` flag is set
 * (ADR-0006).
 */
provider.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess("providerSelfManagement"),
  sValidator("json", providerCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    if (data.modelIds) {
      data.modelIds = dedupeArray(data.modelIds).sort();
    }
    // A duplicate name surfaces as a Postgres unique violation, mapped to 409
    // by the central onError (ADR-0009).
    const record = await db
      .insert(providerTable)
      .values({
        id: nanoid(),
        ...data,
      })
      .returning();
    return c.json(record[0], 201);
  },
);

/** List providers visible in this workspace (workspace-scoped + attached org-scoped) */
provider.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;

    const scoped = await listScoped(db, "provider", {
      orgId,
      wsId: workspaceId,
    });
    const results = scoped.map(({ row, scope }) => ({ ...row, scope }));
    return c.json({ results });
  },
);

/** Get a provider by ID (workspace-scoped, or attached org-scoped) */
provider.get(
  "/:providerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    const providerId = c.req.param("providerId");

    const found = await requireScoped(db, "provider", providerId, {
      orgId,
      wsId: workspaceId,
    });
    return c.json({ ...found.row, scope: found.scope });
  },
);

/** Update a provider by ID (org-admin, or owner when delegated — ADR-0006) */
provider.put(
  "/:providerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess("providerSelfManagement"),
  sValidator("json", providerUpdateSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    const providerId = c.req.param("providerId");
    const data = c.req.valid("json");
    if (data.modelIds) {
      data.modelIds = dedupeArray(data.modelIds).sort();
    }

    // A Shared Provider is a single source of truth edited only on the
    // Organization surface (ADR-0007); requireWorkspaceMutable throws NotFound
    // (→404) when the Provider is not visible here, then Locked (→403) when it
    // is org-scoped.
    await requireWorkspaceMutable(db, "provider", providerId, {
      orgId,
      wsId: workspaceId,
    });

    // Detect and handle embedding config changes before the update
    await handleEmbeddingConfigChange(providerId, data);

    // A duplicate name surfaces as a Postgres unique violation, mapped to 409
    // by the central onError (ADR-0009).
    const record = await db
      .update(providerTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(providerTable.id, providerId),
          eq(providerTable.workspaceId, workspaceId),
        ),
      )
      .returning();

    return c.json(record, 200);
  },
);

/** Delete a provider by ID (org-admin, or owner when delegated — ADR-0006) */
provider.delete(
  "/:providerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess("providerSelfManagement"),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    const providerId = c.req.param("providerId");

    // A Shared Provider is deleted only from the Organization surface
    // (ADR-0007): requireWorkspaceMutable throws NotFound (→404) when the
    // Provider is not visible here, then Locked (→403) when it is org-scoped.
    await requireWorkspaceMutable(db, "provider", providerId, {
      orgId,
      wsId: workspaceId,
    });

    await db
      .delete(providerTable)
      .where(
        and(
          eq(providerTable.id, providerId),
          eq(providerTable.workspaceId, workspaceId),
        ),
      );
    return c.json({ message: "Provider deleted" });
  },
);

export { provider };
