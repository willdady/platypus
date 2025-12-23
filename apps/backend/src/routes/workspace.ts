import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { workspace as workspaceTable, workspaceMember, organisationMember } from "../db/schema.ts";
import {
  workspaceCreateSchema,
  workspaceUpdateSchema,
} from "@platypus/schemas";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess, requireWorkspaceAccess } from "../middleware/authorization.ts";
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
  const orgId = c.req.query("orgId");
  const results = await db
    .select()
    .from(workspaceTable)
    .where(orgId ? eq(workspaceTable.organisationId, orgId) : undefined);
  return c.json({ results });
});

/** Get a workspace by ID */
workspace.get("/:id", requireAuth, requireOrgAccess(), async (c) => {
  const id = c.req.param("id");
  const record = await db
    .select()
    .from(workspaceTable)
    .where(eq(workspaceTable.id, id))
    .limit(1);
  if (record.length === 0) {
    return c.json({ message: "Workspace not found" }, 404);
  }
  return c.json(record[0]);
});

/** Update a workspace by ID (org admin only) */
workspace.put(
  "/:id",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", workspaceUpdateSchema),
  async (c) => {
    const id = c.req.param("id");
    const data = c.req.valid("json");
    const record = await db
      .update(workspaceTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(workspaceTable.id, id))
      .returning();

    if (record.length === 0) {
      return c.json({ message: "Workspace not found" }, 404);
    }

    return c.json(record[0], 200);
  },
);

/** Delete a workspace by ID (org admin only) */
workspace.delete("/:id", requireAuth, requireOrgAccess(["admin"]), async (c) => {
  const id = c.req.param("id");
  await db.delete(workspaceTable).where(eq(workspaceTable.id, id));
  return c.json({ message: "Workspace deleted" });
});

/** Get user's membership for a workspace */
workspace.get(
  "/:workspaceId/membership",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess(),
  async (c) => {
    const user = c.get("user")!;
    const workspaceId = c.req.param("workspaceId");

    // First check if user is org admin (automatic workspace access)
    const [ws] = await db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, workspaceId))
      .limit(1);

    if (!ws) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const [orgMembership] = await db
      .select()
      .from(organisationMember)
      .where(and(
        eq(organisationMember.userId, user.id),
        eq(organisationMember.organisationId, ws.organisationId)
      ))
      .limit(1);

    // Org admins get automatic admin access
    if (orgMembership && orgMembership.role === "admin") {
      return c.json({
        id: "org-admin",
        workspaceId,
        role: "admin",
        inherited: true,
      });
    }

    // Check explicit workspace membership
    const [wsMembership] = await db
      .select()
      .from(workspaceMember)
      .where(and(
        eq(workspaceMember.userId, user.id),
        eq(workspaceMember.workspaceId, workspaceId)
      ))
      .limit(1);

    if (!wsMembership) {
      return c.json({ error: "No workspace access" }, 404);
    }

    return c.json(wsMembership);
  },
);

export { workspace };
