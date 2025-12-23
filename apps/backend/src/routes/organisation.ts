import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { organisation as organisationTable, organisationMember } from "../db/schema.ts";
import {
  organisationCreateSchema,
  organisationUpdateSchema,
} from "@platypus/schemas";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess, requireSuperAdmin, isSuperAdmin } from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

const organisation = new Hono<{ Variables: Variables }>();

/** Create a new organisation (super admin only) */
organisation.post(
  "/",
  requireAuth,
  requireSuperAdmin,
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

/** List all organisations (filtered to user's memberships) */
organisation.get("/", requireAuth, async (c) => {
  const user = c.get("user")!;

  // Super admins see all organisations
  if (isSuperAdmin(user.email)) {
    const results = await db.select().from(organisationTable);
    return c.json({ results });
  }

  // Regular users see only their organisations
  const memberships = await db
    .select({ organisationId: organisationMember.organisationId })
    .from(organisationMember)
    .where(eq(organisationMember.userId, user.id));

  const orgIds = memberships.map(m => m.organisationId);

  if (orgIds.length === 0) {
    return c.json({ results: [] });
  }

  const results = await db
    .select()
    .from(organisationTable)
    .where(inArray(organisationTable.id, orgIds));

  return c.json({ results });
});

/** Get a organisation by ID */
organisation.get("/:id", requireAuth, requireOrgAccess(), async (c) => {
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

/** Update a organisation by ID (admin only) */
organisation.put(
  "/:id",
  requireAuth,
  requireOrgAccess(["admin"]),
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

/** Delete a organisation by ID (admin only) */
organisation.delete("/:id", requireAuth, requireOrgAccess(["admin"]), async (c) => {
  const id = c.req.param("id");
  await db.delete(organisationTable).where(eq(organisationTable.id, id));
  return c.json({ message: "Organisation deleted" });
});

/** Get user's membership for an organisation */
organisation.get("/:orgId/membership", requireAuth, requireOrgAccess(), async (c) => {
  const user = c.get("user")!;
  const orgId = c.req.param("orgId");

  const [membership] = await db
    .select()
    .from(organisationMember)
    .where(and(
      eq(organisationMember.userId, user.id),
      eq(organisationMember.organisationId, orgId)
    ))
    .limit(1);

  if (!membership) {
    return c.json({ error: "Not a member" }, 404);
  }

  return c.json(membership);
});

export { organisation };
