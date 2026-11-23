import { Hono } from "hono";
import { validate } from "../validate.ts";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  organization as organizationTable,
  organizationMember,
  workspace as workspaceTable,
  agent as agentTable,
} from "../db/schema.ts";
import {
  organizationCreateSchema,
  organizationUpdateSchema,
} from "@platypus/schemas";
import { eq, inArray, or } from "drizzle-orm";
import { deleteStoredPrefix } from "../storage/utils.ts";
import { organizationStorageKeyPrefix } from "../storage/keys.ts";
import { deleteAvatar } from "../services/avatar.ts";
import { destroyWorkspaceSandboxes } from "../sandbox/teardown.ts";
import { deleteOrganizationRows } from "../services/organization-delete.ts";
import { requireAuth } from "../middleware/authentication.ts";
import {
  orgScopeOf,
  requireOrgAccess,
  requireSuperAdmin,
  isSuperAdmin,
  userOf,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

const organization = new Hono<{ Variables: Variables }>();

organization.post(
  "/",
  requireAuth,
  requireSuperAdmin,
  validate("json", organizationCreateSchema),
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

organization.get("/", requireAuth, async (c) => {
  const user = userOf(c);

  if (isSuperAdmin(user)) {
    const results = await db.select().from(organizationTable);
    return c.json({ results });
  }

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

organization.get("/:orgId", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const record = await db
    .select()
    .from(organizationTable)
    .where(eq(organizationTable.id, orgId))
    .limit(1);
  if (record.length === 0) {
    return c.json({ error: "Organization not found" }, 404);
  }
  return c.json(record[0]);
});

organization.put(
  "/:orgId",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", organizationUpdateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const data = c.req.valid("json");
    const [record] = await db
      .update(organizationTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(organizationTable.id, orgId))
      .returning();
    if (!record) {
      return c.json({ error: "Organization not found" }, 404);
    }
    return c.json(record, 200);
  },
);

organization.delete(
  "/:orgId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const workspaces = await db
      .select({ id: workspaceTable.id })
      .from(workspaceTable)
      .where(eq(workspaceTable.organizationId, orgId));
    const agents = await db
      .select({ avatarKey: agentTable.avatarKey })
      .from(agentTable)
      .where(
        or(
          eq(agentTable.organizationId, orgId),
          inArray(
            agentTable.workspaceId,
            workspaces.map(({ id }) => id),
          ),
        ),
      );
    await Promise.all(
      workspaces.map(({ id }) => destroyWorkspaceSandboxes(id)),
    );
    await db.transaction((tx) => deleteOrganizationRows(tx, orgId));
    await deleteStoredPrefix(organizationStorageKeyPrefix({ orgId }));
    await Promise.all(agents.map(({ avatarKey }) => deleteAvatar(avatarKey)));
    return c.json({ message: "Organization deleted" });
  },
);

organization.get("/:orgId/membership", requireAuth, requireOrgAccess(), (c) => {
  return c.json(c.get("orgMembership"));
});

export { organization };
