import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  attachment as attachmentTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { requireAuth } from "../middleware/authentication.ts";
import { orgScopeOf, requireOrgAccess } from "../middleware/authorization.ts";
import { isScopedResourceType } from "../services/scoped-resource.ts";
import { attachResource, detachResource } from "../services/attachment.ts";
import type { Variables } from "../server.ts";

// Org-surface management of where a Shared resource is attached (ADR-0007).
// Where the per-Workspace `attachment` route answers "what is attached to THIS
// workspace?", this route answers "which workspaces is THIS resource shared
// with?" and lets an Org Admin attach/detach workspaces centrally — the natural
// place to manage sharing across many workspaces. All routes are admin-only.
// The attach/detach rules (workspace-in-org, resource-is-Shared,
// already-attached → 409) live in the Attachment module; this route is a thin
// adapter over it, supplying an arbitrary `workspaceId` from the request body.
const orgAttachment = new Hono<{ Variables: Variables }>();

/**
 * List the workspaces a Shared resource is attached to (admin only).
 * Requires `resourceType` and `resourceId` query params; returns each
 * attachment with its workspace name so the org surface can show "Shared with".
 */
orgAttachment.get("/", requireAuth, requireOrgAccess(["admin"]), async (c) => {
  const { orgId } = orgScopeOf(c);
  const resourceType = c.req.query("resourceType");
  const resourceId = c.req.query("resourceId");

  if (!isScopedResourceType(resourceType) || !resourceId) {
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
  const { orgId } = orgScopeOf(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    resourceType?: string;
    resourceId?: string;
    workspaceId?: string;
  };
  const { resourceType, resourceId, workspaceId } = body;

  // Every rule — well-formed resourceType, the target workspace belonging to
  // this organization, the resource being a Shared one of it (ADR-0007), and
  // already-attached → 409 — lives in the Attachment module, which also owns
  // the order they fail in.
  const record = await attachResource({ kind: "organization" }, orgId, {
    resourceType,
    resourceId,
    workspaceId,
  });
  return c.json(record, 201);
});

/** Detach an org-scoped Shared resource from a workspace (admin only) */
orgAttachment.delete(
  "/:resourceType/:resourceId/:workspaceId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const resourceType = c.req.param("resourceType");
    const resourceId = c.req.param("resourceId");
    const workspaceId = c.req.param("workspaceId");

    // Guard against detaching across orgs, and let the module throw NotFound
    // (→404) when no such Attachment exists (ADR-0010).
    await detachResource({ kind: "organization" }, orgId, {
      resourceType,
      resourceId,
      workspaceId,
    });

    return c.json({ message: "Detached" });
  },
);

export { orgAttachment };
