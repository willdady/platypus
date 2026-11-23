import { Hono } from "hono";
import { validate } from "../validate.ts";
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

const attachment = new Hono<{ Variables: Variables }>();

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

attachment.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  requireWorkspaceAccess,
  validate("json", attachmentCreateSchema),
  async (c) => {
    const { orgId, workspaceId } = workspaceScopeOf(c);
    const { resourceType, resourceId } = c.req.valid("json");

    const record = await attachResource({ kind: "workspace" }, orgId, {
      resourceType,
      resourceId,
      workspaceId,
    });
    return c.json(record, 201);
  },
);

attachment.delete(
  "/:resourceType/:resourceId",
  requireAuth,
  requireOrgAccess(["admin"]),
  requireWorkspaceAccess,
  async (c) => {
    const { orgId, workspaceId } = workspaceScopeOf(c);
    const resourceType = c.req.param("resourceType");
    const resourceId = c.req.param("resourceId");

    await detachResource({ kind: "workspace" }, orgId, {
      resourceType,
      resourceId,
      workspaceId,
    });

    return c.json({ message: "Detached" });
  },
);

export { attachment };
