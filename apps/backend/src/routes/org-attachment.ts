import { Hono } from "hono";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  attachment as attachmentTable,
  agent as agentTable,
  mcp as mcpTable,
  provider as providerTable,
  skill as skillTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess } from "../middleware/authorization.ts";
import { isUniqueViolation } from "../errors.ts";
import type { Variables } from "../server.ts";

// Org-surface management of where a Shared resource is attached (ADR-0007).
// Where the per-Workspace `attachment` route answers "what is attached to THIS
// workspace?", this route answers "which workspaces is THIS resource shared
// with?" and lets an Org Admin attach/detach workspaces centrally — the natural
// place to manage sharing across many workspaces. All routes are admin-only.
const orgAttachment = new Hono<{ Variables: Variables }>();

const RESOURCE_TABLES = {
  mcp: mcpTable,
  provider: providerTable,
  skill: skillTable,
  agent: agentTable,
} as const;

type ResourceType = keyof typeof RESOURCE_TABLES;

const isResourceType = (v: string | undefined): v is ResourceType =>
  v === "mcp" || v === "provider" || v === "skill" || v === "agent";

/**
 * Confirms a resource is org-scoped and belongs to this organization — you can
 * only manage sharing for a Shared resource, never a workspace-private one.
 */
const orgResourceExists = async (
  resourceType: ResourceType,
  resourceId: string,
  orgId: string,
): Promise<boolean> => {
  const table = RESOURCE_TABLES[resourceType];
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, resourceId), eq(table.organizationId, orgId)))
    .limit(1);
  return rows.length > 0;
};

/**
 * List the workspaces a Shared resource is attached to (admin only).
 * Requires `resourceType` and `resourceId` query params; returns each
 * attachment with its workspace name so the org surface can show "Shared with".
 */
orgAttachment.get("/", requireAuth, requireOrgAccess(["admin"]), async (c) => {
  const orgId = c.req.param("orgId")!;
  const resourceType = c.req.query("resourceType");
  const resourceId = c.req.query("resourceId");

  if (!isResourceType(resourceType) || !resourceId) {
    return c.json(
      { error: "resourceType and resourceId query params are required" },
      400,
    );
  }

  // Join through workspace so we only ever surface this org's workspaces (and
  // their names), never attachments leaked from another org.
  const rows = await db
    .select({
      workspaceId: attachmentTable.workspaceId,
      workspaceName: workspaceTable.name,
      createdAt: attachmentTable.createdAt,
    })
    .from(attachmentTable)
    .innerJoin(
      workspaceTable,
      eq(workspaceTable.id, attachmentTable.workspaceId),
    )
    .where(
      and(
        eq(attachmentTable.resourceType, resourceType),
        eq(attachmentTable.resourceId, resourceId),
        eq(workspaceTable.organizationId, orgId),
      ),
    );

  return c.json({ results: rows });
});

/** Attach an org-scoped Shared resource to a workspace (admin only) */
orgAttachment.post("/", requireAuth, requireOrgAccess(["admin"]), async (c) => {
  const orgId = c.req.param("orgId")!;
  const body = (await c.req.json().catch(() => ({}))) as {
    resourceType?: string;
    resourceId?: string;
    workspaceId?: string;
  };
  const { resourceType, resourceId, workspaceId } = body;

  if (!isResourceType(resourceType)) {
    return c.json({ error: "Invalid resourceType" }, 400);
  }
  if (!resourceId || !workspaceId) {
    return c.json({ error: "resourceId and workspaceId are required" }, 400);
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

  if (!(await orgResourceExists(resourceType, resourceId, orgId))) {
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
        { error: "This resource is already attached to that workspace" },
        409,
      );
    }
    throw error;
  }
});

/** Detach an org-scoped Shared resource from a workspace (admin only) */
orgAttachment.delete(
  "/:resourceType/:resourceId/:workspaceId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const resourceType = c.req.param("resourceType");
    const resourceId = c.req.param("resourceId");
    const workspaceId = c.req.param("workspaceId");

    if (!isResourceType(resourceType)) {
      return c.json({ error: "Invalid resourceType" }, 400);
    }

    // Guard against detaching across orgs: the workspace must be in this org.
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

    const result = await db
      .delete(attachmentTable)
      .where(
        and(
          eq(attachmentTable.workspaceId, workspaceId),
          eq(attachmentTable.resourceType, resourceType),
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

export { orgAttachment };
