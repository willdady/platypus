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
import { eq, inArray } from "drizzle-orm";
import { readRunTimeoutCeilings } from "../services/agent-run-settings.ts";
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
    return c.json({ error: "Organization not found" }, 404);
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

    // Reject overrides above the deployer-supplied environment ceiling. Org
    // admins can lower the timeout but never raise it past what the host
    // operator allows.
    if (data.agentRunSettings) {
      const chatCeiling = readRunTimeoutCeilings("chat");
      const triggerCeiling = readRunTimeoutCeilings("trigger");
      const s = data.agentRunSettings;
      const checks: {
        value: number | undefined;
        ceiling: number;
        envVar: string;
      }[] = [
        {
          value: s.chatPerRunTimeoutMs,
          ceiling: chatCeiling.perRunTimeoutMs,
          envVar: "RUN_PER_RUN_TIMEOUT_MS",
        },
        {
          value: s.chatPerStepTimeoutMs,
          ceiling: chatCeiling.perStepTimeoutMs,
          envVar: "RUN_PER_STEP_TIMEOUT_MS",
        },
        {
          value: s.triggerPerRunTimeoutMs,
          ceiling: triggerCeiling.perRunTimeoutMs,
          envVar: "TRIGGER_PER_RUN_TIMEOUT_MS",
        },
        {
          value: s.triggerPerStepTimeoutMs,
          ceiling: triggerCeiling.perStepTimeoutMs,
          envVar: "TRIGGER_PER_STEP_TIMEOUT_MS",
        },
      ];
      const exceeded = checks
        .filter((ch) => ch.value !== undefined && ch.value > ch.ceiling)
        .map(
          (ch) => `${ch.envVar} (max ${Math.round(ch.ceiling / 60000)} min)`,
        );
      if (exceeded.length > 0) {
        return c.json(
          {
            error: `Timeout override exceeds the deployer-allowed ceiling: ${exceeded.join(", ")}`,
          },
          400,
        );
      }
    }

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

/** Get the environment-supplied timeout ceilings — used by the org settings
 *  UI to display the upper bounds for the per-org overrides. */
organization.get(
  "/:orgId/agent-run-settings/ceilings",
  requireAuth,
  requireOrgAccess(),
  (c) => {
    return c.json({
      chat: readRunTimeoutCeilings("chat"),
      trigger: readRunTimeoutCeilings("trigger"),
    });
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
organization.get("/:orgId/membership", requireAuth, requireOrgAccess(), (c) => {
  return c.json(c.get("orgMembership"));
});

export { organization };
