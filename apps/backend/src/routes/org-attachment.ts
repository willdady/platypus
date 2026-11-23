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

const orgAttachment = new Hono<{ Variables: Variables }>();

orgAttachment.get(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("query", attachmentListQuerySchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const { resourceType, resourceId } = c.req.valid("query");

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
