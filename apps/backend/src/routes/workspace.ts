import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { workspace as workspaceTable } from "../db/schema.ts";
import {
  workspaceCreateSchema,
  workspaceUpdateSchema,
} from "@platypus/schemas";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware.ts";

const workspace = new Hono();

// Require authentication for all routes
workspace.use("*", requireAuth);

/** Create a new workspace */
workspace.post(
  "/",
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
workspace.get("/", async (c) => {
  const orgId = c.req.query("orgId");
  const results = await db
    .select()
    .from(workspaceTable)
    .where(orgId ? eq(workspaceTable.organisationId, orgId) : undefined);
  return c.json({ results });
});

/** Get a workspace by ID */
workspace.get("/:id", async (c) => {
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

/** Update a workspace by ID */
workspace.put("/:id", sValidator("json", workspaceUpdateSchema), async (c) => {
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
});

/** Delete a workspace by ID */
workspace.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await db.delete(workspaceTable).where(eq(workspaceTable.id, id));
  return c.json({ message: "Workspace deleted" });
});

export { workspace };
