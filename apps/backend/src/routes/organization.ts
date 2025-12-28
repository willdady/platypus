import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  organization as organizationTable,
  organizationMember,
} from "../db/schema.ts";
import {
  organizationCreateSchema,
  organizationUpdateSchema,
} from "@platypus/schemas";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireSuperAdmin,
  isSuperAdmin,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

const organization = new Hono<{ Variables: Variables }>();

/** Create a new organization (super admin only) */
organization.post(
  "/",
  requireAuth,
  requireSuperAdmin,
  sValidator("json", organizationCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const record = await db
      .insert(organizationTable)
      .values({
        id: nanoid(),
        ...data,
      })
      .returning();
    return c.json(record[0], 201);
  },
);

/** List all organizations (filtered to user's memberships) */
organization.get("/", requireAuth, async (c) => {
  const user = c.get("user")!;

  // Super admins see all organizations
  if (isSuperAdmin(user)) {
    const results = await db.select().from(organizationTable);
    return c.json({ results });
  }

  // Regular users see only their organizations
  const memberships = await db
    .select({ organizationId: organizationMember.organizationId })
    .from(organizationMember)
    .where(eq(organizationMember.userId, user.id));

  const orgIds = memberships.map((m) => m.organizationId);

  if (orgIds.length === 0) {
    return c.json({ results: [] });
  }

  const results = await db
    .select()
    .from(organizationTable)
    .where(inArray(organizationTable.id, orgIds));

  return c.json({ results });
});

/** Get a organization by ID */
organization.get("/:orgId", requireAuth, requireOrgAccess(), async (c) => {
  const orgId = c.req.param("orgId");
  const record = await db
    .select()
    .from(organizationTable)
    .where(eq(organizationTable.id, orgId))
    .limit(1);
  if (record.length === 0) {
    return c.json({ message: "Organization not found" }, 404);
  }
  return c.json(record[0]);
});

/** Update a organization by ID (admin only) */
organization.put(
  "/:orgId",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", organizationUpdateSchema),
  async (c) => {
    const orgId = c.req.param("orgId");
    const data = c.req.valid("json");
    const record = await db
      .update(organizationTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(organizationTable.id, orgId))
      .returning();
    return c.json(record, 200);
  },
);

/** Delete a organization by ID (admin only) */
organization.delete(
  "/:orgId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const orgId = c.req.param("orgId");
    await db.delete(organizationTable).where(eq(organizationTable.id, orgId));
    return c.json({ message: "Organization deleted" });
  },
);

/** Get user's membership for an organization */
organization.get(
  "/:orgId/membership",
  requireAuth,
  requireOrgAccess(),
  async (c) => {
    return c.json(c.get("orgMembership"));
  },
);

export { organization };
