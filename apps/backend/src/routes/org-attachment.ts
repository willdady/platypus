import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { attachmentListQuerySchema } from "@platypus/schemas";
import { db } from "../index.ts";
import {
  attachment as attachmentTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { requireAuth } from "../middleware/authentication.ts";
import { orgScopeOf, requireOrgAccess } from "../middleware/authorization.ts";
import { validate } from "../validate.ts";
import type { Variables } from "../server.ts";

// Org-surface read of where a Shared resource is attached (ADR-0007). Where
// the per-Workspace `attachment` route answers "what is attached to THIS
// workspace?", this route answers "which workspaces is THIS resource shared
// with?". Every write uses the one attachment address — the per-Workspace
// route, whose path names the Workspace so the body never has to. All routes
// are admin-only.
const orgAttachment = new Hono<{ Variables: Variables }>();

/**
 * List the workspaces a Shared resource is attached to (admin only).
 * Requires `resourceType` and `resourceId` query params; returns each
 * attachment with its workspace name so the org surface can show "Shared with".
 */
orgAttachment.get(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("query", attachmentListQuerySchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const { resourceType, resourceId } = c.req.valid("query");

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
  },
);

export { orgAttachment };
