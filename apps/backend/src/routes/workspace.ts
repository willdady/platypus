import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  workspace as workspaceTable,
  workspaceMember,
  organisationMember,
} from "../db/schema.ts";
import {
  workspaceCreateSchema,
  workspaceUpdateSchema,
} from "@platypus/schemas";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

const workspace = new Hono<{ Variables: Variables }>();

/** Create a new workspace (org admin only) */
workspace.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", workspaceCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const record = await db
      .insert(workspaceTable)
      .values({
        id: nanoid(),
        ...data,
      })
      .returning();
    return c.json(record[0], 201);
  },
);

/** List all workspaces */
workspace.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const orgId = c.req.param("orgId")!;
  const results = await db
    .select()
    .from(workspaceTable)
    .where(eq(workspaceTable.organisationId, orgId));
  return c.json({ results });
});

/** Get a workspace by ID */
workspace.get("/:workspaceId", requireAuth, requireOrgAccess(), async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const record = await db
    .select()
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);
  if (record.length === 0) {
    return c.json({ message: "Workspace not found" }, 404);
  }
  return c.json(record[0]);
});

/** Update a workspace by ID (org admin only) */
workspace.put(
  "/:workspaceId",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", workspaceUpdateSchema),
  async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const data = c.req.valid("json");
    const record = await db
      .update(workspaceTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(workspaceTable.id, workspaceId))
      .returning();

    if (record.length === 0) {
      return c.json({ message: "Workspace not found" }, 404);
    }

    return c.json(record[0], 200);
  },
);

/** Delete a workspace by ID (org admin only) */
workspace.delete(
  "/:workspaceId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await db.delete(workspaceTable).where(eq(workspaceTable.id, workspaceId));
    return c.json({ message: "Workspace deleted" });
  },
);

/** Get user's membership for a workspace */
workspace.get(
  "/:workspaceId/membership",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess(),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const workspaceRole = c.get("workspaceRole");
    const workspaceMembership = c.get("workspaceMembership");

    if (workspaceMembership) {
      return c.json(workspaceMembership);
    }

    // If no explicit membership but has role (e.g. org admin or super admin), return inherited membership
    return c.json({
      id: "inherited",
      workspaceId,
      role: workspaceRole,
      inherited: true,
    });
  },
);

export { workspace };
