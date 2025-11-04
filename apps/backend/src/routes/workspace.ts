import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { workspace as workspaceTable } from "../db/schema.ts";
import {
  workspaceCreateSchema,
  workspaceUpdateSchema,
} from "@agent-kit/schemas";
import { eq } from "drizzle-orm";
import { organisationMiddleware } from "../middleware.ts";

const workspace = new Hono();

/** Create a new workspace */
workspace.post(
  "/",
  sValidator("json", workspaceCreateSchema),
  organisationMiddleware,
  async (c) => {
    const data = c.req.valid("json");
    const record = await db
      .insert(workspaceTable)
      .values({
        id: nanoid(),
        ...data,
      })
      .returning();
    return c.json(record, 201);
  },
);

/** List all workspaces */
workspace.get("/", async (c) => {
  const results = await db.select().from(workspaceTable);
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
  return c.json(record, 200);
});

/** Delete a workspace by ID */
workspace.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await db.delete(workspaceTable).where(eq(workspaceTable.id, id));
  return c.json({ message: "Workspace deleted" });
});

export { workspace };
