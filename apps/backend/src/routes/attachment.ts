import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  attachment as attachmentTable,
  mcp as mcpTable,
  provider as providerTable,
} from "../db/schema.ts";
import { attachmentCreateSchema } from "@platypus/schemas";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

// Attachment is the explicit reference that surfaces an org-scoped Shared
// resource inside a Workspace (ADR-0007). Managing attachments is an Org Admin
// action — `requireOrgAccess(["admin"])` rejects non-admins with 403 — scoped
// to a specific Workspace via `requireWorkspaceAccess`.
const attachment = new Hono<{ Variables: Variables }>();

/** Detects a Postgres unique-constraint violation across driver shapes. */
const isUniqueViolation = (error: any): boolean =>
  error.code === "23505" ||
  error.cause?.code === "23505" ||
  error.message?.includes("unique constraint") ||
  error.cause?.message?.includes("unique constraint");

/** List attachments for this workspace (admin only) */
attachment.get(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const results = await db
      .select()
      .from(attachmentTable)
      .where(eq(attachmentTable.workspaceId, workspaceId));
    return c.json({ results });
  },
);

/** Attach an org-scoped Shared resource to this workspace (admin only) */
attachment.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  requireWorkspaceAccess,
  sValidator("json", attachmentCreateSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    const { resourceType, resourceId } = c.req.valid("json");

    // The resource must be org-scoped and belong to this organization — you can
    // only attach a Shared resource, never a workspace-scoped one.
    const table = resourceType === "mcp" ? mcpTable : providerTable;
    const resource = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, resourceId), eq(table.organizationId, orgId)))
      .limit(1);
    if (resource.length === 0) {
      return c.json(
        { error: "Org-scoped resource not found in this organization" },
        404,
      );
    }

    try {
      const record = await db
        .insert(attachmentTable)
        .values({ id: nanoid(), workspaceId, resourceType, resourceId })
        .returning();
      return c.json(record[0], 201);
    } catch (error: any) {
      if (isUniqueViolation(error)) {
        return c.json(
          { error: "This resource is already attached to this workspace" },
          409,
        );
      }
      throw error;
    }
  },
);

/** Detach an org-scoped Shared resource from this workspace (admin only) */
attachment.delete(
  "/:resourceType/:resourceId",
  requireAuth,
  requireOrgAccess(["admin"]),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const resourceType = c.req.param("resourceType");
    const resourceId = c.req.param("resourceId");

    const result = await db
      .delete(attachmentTable)
      .where(
        and(
          eq(attachmentTable.workspaceId, workspaceId),
          eq(attachmentTable.resourceType, resourceType as "mcp" | "provider"),
          eq(attachmentTable.resourceId, resourceId),
        ),
      )
      .returning();
    if (result.length === 0) {
      return c.json({ error: "Attachment not found" }, 404);
    }
    return c.json({ message: "Detached" });
  },
);

export { attachment };
