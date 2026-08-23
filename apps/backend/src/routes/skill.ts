import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  skill as skillTable,
  agent as agentTable,
  attachment as attachmentTable,
} from "../db/schema.ts";
import { skillCreateSchema, skillUpdateSchema } from "@platypus/schemas";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import {
  listScoped,
  requireScoped,
  workspaceScopedWhere,
} from "../services/scoped-resource.ts";
import { createSkill, deleteSkill, updateSkill } from "../services/skill.ts";
import { NotFoundError } from "../errors.ts";
import type { Variables } from "../server.ts";

const skill = new Hono<{ Variables: Variables }>();

/** List skills visible in this workspace (workspace-scoped + attached org-scoped) */
skill.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    // Workspace-scoped Skills plus the attached org-scoped (Shared) ones, each
    // tagged with its scope for the frontend (locked cards for org).
    const scoped = await listScoped(db, "skill", workspaceScopeOf(c));
    const results = scoped.map(({ row, scope }) => ({ ...row, scope }));

    return c.json({ results });
  },
);

/** Get a skill by ID */
skill.get(
  "/:skillId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const scope = workspaceScopeOf(c);
    const skillId = c.req.param("skillId");

    // Resolve the Skill visible here — Workspace-scoped, or an attached
    // org-scoped (Shared) one (ADR-0007); not visible → 404 via onError.
    const found = await requireScoped(db, "skill", skillId, scope);

    // Find workspace agents that have this skill assigned
    const agentsWithSkill = await db
      .select({ id: agentTable.id })
      .from(agentTable)
      .where(
        and(
          eq(agentTable.workspaceId, scope.workspaceId),
          sql`${agentTable.skillIds} @> ${JSON.stringify([skillId])}::jsonb`,
        ),
      );

    return c.json({
      ...found.row,
      scope: found.scope,
      agentIds: agentsWithSkill.map((a) => a.id),
    });
  },
);

/** Create a new skill (editor+) */
skill.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", skillCreateSchema),
  async (c) => {
    const scope = workspaceScopeOf(c);
    const data = c.req.valid("json");

    // The workspace route only ever creates workspace-scoped Skills; the scope
    // is taken from the route, never the body (org-scoped Skills are created
    // via the Organization surface or by Promote). A duplicate name surfaces as
    // a Postgres unique violation, mapped to 409 by the central onError
    // (ADR-0010).
    const row = await createSkill({ kind: "workspace", ctx: scope }, data);
    return c.json(row, 201);
  },
);

/** Update a skill by ID (editor+) */
skill.put(
  "/:skillId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", skillUpdateSchema),
  async (c) => {
    const scope = workspaceScopeOf(c);
    const skillId = c.req.param("skillId");
    const data = c.req.valid("json");

    // A Shared Skill is a single source of truth edited only on the Organization
    // surface (ADR-0007); `updateSkill` throws NotFound (→404) when the Skill is
    // not visible here, then Locked (→403) when it is org-scoped. A duplicate
    // name surfaces as a Postgres unique violation, mapped to 409 by the
    // central onError (ADR-0010).
    const row = await updateSkill(
      { kind: "workspace", ctx: scope },
      skillId,
      data,
    );
    return c.json(row, 200);
  },
);

/** Delete a skill by ID (editor+) */
skill.delete(
  "/:skillId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const scope = workspaceScopeOf(c);
    const skillId = c.req.param("skillId");

    // A Shared Skill is deleted only from the Organization surface (ADR-0007):
    // `deleteSkill` throws NotFound (→404) when the Skill is not visible here,
    // then Locked (→403) when it is org-scoped, and Conflict (→409) while a
    // Workspace agent still references it.
    await deleteSkill({ kind: "workspace", ctx: scope }, skillId);

    return c.json({ message: "Skill deleted" });
  },
);

/**
 * Promote a workspace-scoped Skill to Organization scope (admin only — ADR-0007).
 *
 * Re-scopes the Skill from this Workspace to the Organization, turning it into a
 * Shared resource, and auto-attaches the origin Workspace so the author keeps
 * using/editing it in place. A Skill is leaf text (it references no other
 * resource), so there is no "references must already be Shared" prerequisite —
 * Skills establish the Promote pattern that Agents build on. Workspace Agents
 * that already reference the Skill keep their references intact (the id is
 * unchanged) and resolve it at Chat-turn time via the Attachment.
 */
skill.post(
  "/:skillId/promote",
  requireAuth,
  requireOrgAccess(["admin"]),
  requireWorkspaceAccess,
  async (c) => {
    const { orgId, workspaceId } = workspaceScopeOf(c);
    const skillId = c.req.param("skillId");

    // Only a workspace-scoped Skill in this workspace can be promoted.
    const [existing] = await db
      .select()
      .from(skillTable)
      .where(workspaceScopedWhere("skill", skillId, workspaceId))
      .limit(1);
    if (!existing) {
      throw new NotFoundError("Skill not found");
    }

    // Sentinel for a lost TOCTOU race: the Skill was re-scoped or deleted
    // between the lookup above and the in-transaction update. Throwing rolls
    // back the auto-attach so we never leave a dangling Attachment.
    const PROMOTE_RACE = "skill_no_longer_workspace_scoped";

    try {
      const promoted = await db.transaction(async (tx) => {
        const [record] = await tx
          .update(skillTable)
          .set({
            organizationId: orgId,
            workspaceId: null,
            updatedAt: new Date(),
          })
          .where(workspaceScopedWhere("skill", skillId, workspaceId))
          .returning();

        if (!record) {
          throw new Error(PROMOTE_RACE);
        }

        // Auto-attach the origin Workspace so it keeps seeing the Skill.
        await tx
          .insert(attachmentTable)
          .values({
            id: nanoid(),
            workspaceId,
            resourceType: "skill",
            resourceId: skillId,
          })
          .onConflictDoNothing();

        return record;
      });

      return c.json({ ...promoted, scope: "organization" }, 200);
    } catch (error) {
      if (error instanceof Error && error.message === PROMOTE_RACE) {
        throw new NotFoundError("Skill not found");
      }
      // A duplicate Shared-Skill name surfaces as a Postgres unique violation,
      // mapped to 409 by the central onError (ADR-0010).
      throw error;
    }
  },
);

export { skill };
