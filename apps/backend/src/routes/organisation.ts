import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { organisation as organisationTable } from "../db/schema.ts";
import {
  organisationCreateSchema,
  organisationUpdateSchema,
} from "@platypus/schemas";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware.ts";

const organisation = new Hono();

// Require authentication for all routes
organisation.use("*", requireAuth);

/** Create a new organisation */
organisation.post(
  "/",
  sValidator("json", organisationCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const record = await db
      .insert(organisationTable)
      .values({
        id: nanoid(),
        ...data,
      })
      .returning();
    return c.json(record[0], 201);
  },
);

/** List all organisations */
organisation.get("/", async (c) => {
  const results = await db.select().from(organisationTable);
  return c.json({ results });
});

/** Get a organisation by ID */
organisation.get("/:id", async (c) => {
  const id = c.req.param("id");
  const record = await db
    .select()
    .from(organisationTable)
    .where(eq(organisationTable.id, id))
    .limit(1);
  if (record.length === 0) {
    return c.json({ message: "Organisation not found" }, 404);
  }
  return c.json(record[0]);
});

/** Update a organisation by ID */
organisation.put(
  "/:id",
  sValidator("json", organisationUpdateSchema),
  async (c) => {
    const id = c.req.param("id");
    const data = c.req.valid("json");
    const record = await db
      .update(organisationTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(organisationTable.id, id))
      .returning();
    return c.json(record, 200);
  },
);

/** Delete a organisation by ID */
organisation.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await db.delete(organisationTable).where(eq(organisationTable.id, id));
  return c.json({ message: "Organisation deleted" });
});

export { organisation };
