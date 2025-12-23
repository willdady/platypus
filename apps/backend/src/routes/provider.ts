import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { provider as providerTable } from "../db/schema.ts";
import { providerCreateSchema, providerUpdateSchema } from "@platypus/schemas";
import { eq } from "drizzle-orm";
import { dedupeArray } from "../utils.ts";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess, requireWorkspaceAccess } from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

const provider = new Hono<{ Variables: Variables }>();

/** Create a new provider (admin only) */
provider.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess(["admin"]),
  sValidator("json", providerCreateSchema),
  async (c) => {
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
  },
);

/** List all providers */
provider.get("/", requireAuth, requireOrgAccess(), requireWorkspaceAccess(), async (c) => {
  const workspaceId = c.req.query("workspaceId");
  const results = await db
    .select()
    .from(providerTable)
    .where(
      workspaceId ? eq(providerTable.workspaceId, workspaceId) : undefined,
    );
  return c.json({ results });
});

/** Get a provider by ID */
provider.get("/:id", requireAuth, requireOrgAccess(), requireWorkspaceAccess(), async (c) => {
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

/** Update a provider by ID (admin only) */
provider.put(
  "/:id",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess(["admin"]),
  sValidator("json", providerUpdateSchema),
  async (c) => {
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
  },
);

/** Delete a provider by ID (admin only) */
provider.delete(
  "/:id",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess(["admin"]),
  async (c) => {
    const id = c.req.param("id");
    await db.delete(providerTable).where(eq(providerTable.id, id));
    return c.json({ message: "Provider deleted" });
  },
);

export { provider };
