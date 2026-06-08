import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { skill as skillTable } from "../db/schema.ts";
import { skillCreateSchema, skillUpdateSchema } from "@platypus/schemas";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess } from "../middleware/authorization.ts";
import { scrubDeletedAgentReference } from "../services/agent-references.ts";
import { requireSharedDeletable } from "../services/scoped-resource.ts";
import { NotFoundError } from "../errors.ts";
import type { Variables } from "../server.ts";

// Org-scoped Skills are Shared resources (ADR-0007): a single source of truth
// defined once at Organization scope and referenced by Workspaces through an
// Attachment. They are managed only by Org Admins on the Organization surface,
// so all mutations are org-admin-only; any member may read them.
const orgSkill = new Hono<{ Variables: Variables }>();

/** Create an org-scoped Skill (admin only) */
orgSkill.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", skillCreateSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    // Agent associations are a workspace concern; org-scoped Skills carry none.
    const { agentIds: _agentIds, ...data } = c.req.valid("json");

    // A duplicate name surfaces as a Postgres unique violation, mapped to 409
    // by the central onError (ADR-0009).
    const record = await db
      .insert(skillTable)
      .values({
        id: nanoid(),
        name: data.name,
        description: data.description,
        body: data.body,
        organizationId: orgId,
        workspaceId: null,
      })
      .returning();
    return c.json(record[0], 201);
  },
);

/** List org-scoped Skills */
orgSkill.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const orgId = c.req.param("orgId")!;
  const results = await db
    .select()
    .from(skillTable)
    .where(eq(skillTable.organizationId, orgId));
  return c.json({ results });
});

/** Get an org-scoped Skill by ID */
orgSkill.get("/:skillId", requireAuth, requireOrgAccess(), async (c) => {
  const orgId = c.req.param("orgId")!;
  const skillId = c.req.param("skillId");
  const record = await db
    .select()
    .from(skillTable)
    .where(
      and(eq(skillTable.id, skillId), eq(skillTable.organizationId, orgId)),
    )
    .limit(1);
  if (record.length === 0) {
    throw new NotFoundError("Skill not found");
  }
  return c.json(record[0]);
});

/** Update an org-scoped Skill by ID (admin only) */
orgSkill.put(
  "/:skillId",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", skillUpdateSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const skillId = c.req.param("skillId");
    const { agentIds: _agentIds, ...data } = c.req.valid("json");

    // A duplicate name surfaces as a Postgres unique violation, mapped to 409
    // by the central onError (ADR-0009).
    const record = await db
      .update(skillTable)
      .set({
        name: data.name,
        description: data.description,
        body: data.body,
        updatedAt: new Date(),
      })
      .where(
        and(eq(skillTable.id, skillId), eq(skillTable.organizationId, orgId)),
      )
      .returning();
    if (record.length === 0) {
      throw new NotFoundError("Skill not found");
    }
    return c.json(record[0], 200);
  },
);

/** Delete an org-scoped Skill by ID (admin only) */
orgSkill.delete(
  "/:skillId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const skillId = c.req.param("skillId");

    // A Shared resource cannot be deleted while anything still points at it —
    // an Attachment (ADR-0007) or a Blueprint (ADR-0008). Throws ConflictError
    // → 409 via the central onError (ADR-0009).
    await requireSharedDeletable(db, "skill", skillId);

    // Delete the Skill and scrub its (now-dead) id from any Agent's skillIds in
    // the same transaction, so deletion never leaves dangling references.
    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .delete(skillTable)
        .where(
          and(eq(skillTable.id, skillId), eq(skillTable.organizationId, orgId)),
        )
        .returning();
      if (rows.length > 0) {
        await scrubDeletedAgentReference(tx, "skillIds", skillId);
      }
      return rows;
    });
    if (result.length === 0) {
      throw new NotFoundError("Skill not found");
    }
    return c.json({ message: "Skill deleted" });
  },
);

export { orgSkill };
