import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { workspace as workspaceTable } from "../db/schema.ts";
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

/** Create a new workspace (any org member) */
workspace.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  sValidator("json", workspaceCreateSchema),
  async (c) => {
    const user = c.get("user")!;
    const data = c.req.valid("json");
    const record = await db
      .insert(workspaceTable)
      .values({
        id: nanoid(),
        ...data,
        ownerId: user.id,
      })
      .returning();
    return c.json(record[0], 201);
  },
);

/** List all workspaces */
workspace.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const orgId = c.req.param("orgId")!;
  const orgMembership = c.get("orgMembership")!;
  const user = c.get("user")!;

  // If admin, return all workspaces
  if (orgMembership.role === "admin") {
    const results = await db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.organizationId, orgId));
    return c.json({ results });
  }

  // If regular member, return only workspaces they own
  const results = await db
    .select()
    .from(workspaceTable)
    .where(
      and(
        eq(workspaceTable.organizationId, orgId),
        eq(workspaceTable.ownerId, user.id),
      ),
    );
  return c.json({ results });
});

/** Get a workspace by ID */
workspace.get(
  "/:workspaceId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
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
  },
);

/** Update a workspace by ID (owner or org admin) */
workspace.put(
  "/:workspaceId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
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

/** Delete a workspace by ID (owner or org admin) */
workspace.delete(
  "/:workspaceId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await db.delete(workspaceTable).where(eq(workspaceTable.id, workspaceId));
    return c.json({ message: "Workspace deleted" });
  },
);

export { workspace };
