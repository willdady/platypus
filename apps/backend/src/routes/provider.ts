import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { provider as providerTable } from "../db/schema.ts";
import { providerCreateSchema, providerUpdateSchema } from "@agent-kit/schemas";
import { eq } from "drizzle-orm";
import { dedupeArray } from "../utils.ts";

const provider = new Hono();

/** Create a new provider */
provider.post("/", sValidator("json", providerCreateSchema), async (c) => {
  const data = c.req.valid("json");
  if (data.modelIds) {
    data.modelIds = dedupeArray(data.modelIds).sort();
  }
  const record = await db
    .insert(providerTable)
    .values({
      id: nanoid(),
      ...data,
    })
    .returning();
  return c.json(record[0], 201);
});

/** List all providers */
provider.get("/", async (c) => {
  const workspaceId = c.req.query("workspaceId");
  const results = await db
    .select()
    .from(providerTable)
    .where(workspaceId ? eq(providerTable.workspaceId, workspaceId) : undefined);
  return c.json({ results });
});

/** Get a provider by ID */
provider.get("/:id", async (c) => {
  const id = c.req.param("id");
  const record = await db
    .select()
    .from(providerTable)
    .where(eq(providerTable.id, id))
    .limit(1);
  if (record.length === 0) {
    return c.json({ message: "Provider not found" }, 404);
  }
  return c.json(record[0]);
});

/** Update a provider by ID */
provider.put("/:id", sValidator("json", providerUpdateSchema), async (c) => {
  const id = c.req.param("id");
  const data = c.req.valid("json");
  if (data.modelIds) {
    data.modelIds = dedupeArray(data.modelIds).sort();
  }
  const record = await db
    .update(providerTable)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(providerTable.id, id))
    .returning();
  return c.json(record, 200);
});

/** Delete a provider by ID */
provider.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await db.delete(providerTable).where(eq(providerTable.id, id));
  return c.json({ message: "Provider deleted" });
});

export { provider };
