import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { db } from "../index.ts";
import { attachment as attachmentTable } from "../db/schema.ts";
import { attachmentCreateSchema } from "@platypus/schemas";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import { attachResource, detachResource } from "../services/attachment.ts";
import type { Variables } from "../server.ts";

// Attachment is the explicit reference that surfaces an org-scoped Shared
// resource inside a Workspace (ADR-0007). Managing attachments is an Org Admin
// action — `requireOrgAccess(["admin"])` rejects non-admins with 403 — scoped
// to a specific Workspace via `requireWorkspaceAccess`. The attach/detach rules
// (resource-is-Shared, already-attached → 409) live in the Attachment module;
// this route is a thin adapter over it.
const attachment = new Hono<{ Variables: Variables }>();

/** List attachments for this workspace (admin only) */
attachment.get(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  requireWorkspaceAccess,
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
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
    const { orgId, workspaceId } = workspaceScopeOf(c);
    const { resourceType, resourceId } = c.req.valid("json");

    // The target Workspace is this route's own (already proved to belong to the
    // Organization by requireWorkspaceAccess); the module checks the resource
    // is a Shared one of this Organization (→404) and that it is not already
    // attached (→409, ADR-0007/ADR-0010).
    const record = await attachResource({ kind: "workspace" }, orgId, {
      resourceType,
      resourceId,
      workspaceId,
    });
    return c.json(record, 201);
  },
);

/** Detach an org-scoped Shared resource from this workspace (admin only) */
attachment.delete(
  "/:resourceType/:resourceId",
  requireAuth,
  requireOrgAccess(["admin"]),
  requireWorkspaceAccess,
  async (c) => {
    const { orgId, workspaceId } = workspaceScopeOf(c);
    const resourceType = c.req.param("resourceType");
    const resourceId = c.req.param("resourceId");

    // `detachResource` validates the path-typed resourceType and throws
    // NotFound (→404) when no such Attachment exists (ADR-0010).
    await detachResource({ kind: "workspace" }, orgId, {
      resourceType,
      resourceId,
      workspaceId,
    });

    return c.json({ message: "Detached" });
  },
);

export { attachment };
