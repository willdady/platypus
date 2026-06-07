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
import { eq, and, sql, inArray, notInArray } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
import {
  listScoped,
  requireScoped,
  requireWorkspaceMutable,
} from "../services/scoped-resource.ts";
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
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;

    // Workspace-scoped Skills plus the attached org-scoped (Shared) ones, each
    // tagged with its scope for the frontend (locked cards for org).
    const scoped = await listScoped(db, "skill", { orgId, wsId: workspaceId });
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
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    const skillId = c.req.param("skillId");

    // Resolve the Skill visible here — Workspace-scoped, or an attached
    // org-scoped (Shared) one (ADR-0007); not visible → 404 via onError.
    const found = await requireScoped(db, "skill", skillId, {
      orgId,
      wsId: workspaceId,
    });

    // Find workspace agents that have this skill assigned
    const agentsWithSkill = await db
      .select({ id: agentTable.id })
      .from(agentTable)
      .where(
        and(
          eq(agentTable.workspaceId, workspaceId),
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
    const workspaceId = c.req.param("workspaceId")!;
    const { agentIds, ...data } = c.req.valid("json");

    const newId = nanoid();
    // The workspace route only ever creates workspace-scoped Skills; the scope
    // is taken from the route, never the body (org-scoped Skills are created via
    // the Organization surface or by Promote). A duplicate name surfaces as a
    // Postgres unique violation, mapped to 409 by the central onError (ADR-0009).
    const record = await db
      .insert(skillTable)
      .values({
        id: newId,
        name: data.name,
        description: data.description,
        body: data.body,
        workspaceId,
        organizationId: null,
      })
      .returning();

    // Add skill to specified agents
    if (agentIds && agentIds.length > 0) {
      const newIdJson = JSON.stringify([newId]);
      await db
        .update(agentTable)
        .set({
          skillIds: sql`${agentTable.skillIds} || ${newIdJson}::jsonb`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentTable.workspaceId, workspaceId),
            inArray(agentTable.id, agentIds),
            sql`NOT ${agentTable.skillIds} @> ${newIdJson}::jsonb`,
          ),
        );
    }

    return c.json(record[0], 201);
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
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    const skillId = c.req.param("skillId");
    const { agentIds, ...data } = c.req.valid("json");

    // A Shared Skill is a single source of truth edited only on the Organization
    // surface (ADR-0007); requireWorkspaceMutable throws NotFound (→404) when the
    // Skill is not visible here, then Locked (→403) when it is org-scoped.
    await requireWorkspaceMutable(db, "skill", skillId, {
      orgId,
      wsId: workspaceId,
    });

    // A duplicate name surfaces as a Postgres unique violation, mapped to 409
    // by the central onError (ADR-0009).
    const record = await db
      .update(skillTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(skillTable.id, skillId),
          eq(skillTable.workspaceId, workspaceId),
        ),
      )
      .returning();

    // Update agent associations if agentIds was provided
    if (agentIds !== undefined) {
      const now = new Date();
      const skillIdJson = JSON.stringify([skillId]);

      // Remove skill from agents not in the new list
      const removeWhere = [
        eq(agentTable.workspaceId, workspaceId),
        sql`${agentTable.skillIds} @> ${skillIdJson}::jsonb`,
      ];
      if (agentIds.length > 0) {
        removeWhere.push(notInArray(agentTable.id, agentIds));
      }
      await db
        .update(agentTable)
        .set({
          skillIds: sql`(${agentTable.skillIds})::jsonb - ${skillId}::text`,
          updatedAt: now,
        })
        .where(and(...removeWhere));

      // Add skill to agents in the new list that don't already have it
      if (agentIds.length > 0) {
        await db
          .update(agentTable)
          .set({
            skillIds: sql`${agentTable.skillIds} || ${skillIdJson}::jsonb`,
            updatedAt: now,
          })
          .where(
            and(
              eq(agentTable.workspaceId, workspaceId),
              inArray(agentTable.id, agentIds),
              sql`NOT ${agentTable.skillIds} @> ${skillIdJson}::jsonb`,
            ),
          );
      }
    }

    return c.json(record[0], 200);
  },
);

/** Delete a skill by ID (editor+) */
skill.delete(
  "/:skillId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    const skillId = c.req.param("skillId");

    // A Shared Skill is deleted only from the Organization surface (ADR-0007):
    // requireWorkspaceMutable throws NotFound (→404) when the Skill is not
    // visible here, then Locked (→403) when it is org-scoped.
    await requireWorkspaceMutable(db, "skill", skillId, {
      orgId,
      wsId: workspaceId,
    });

    // Check if skill is referenced by any agent
    const referencingAgents = await db
      .select()
      .from(agentTable)
      .where(
        and(
          eq(agentTable.workspaceId, workspaceId),
          sql`${agentTable.skillIds} @> ${JSON.stringify([skillId])}::jsonb`,
        ),
      )
      .limit(1);

    if (referencingAgents.length > 0) {
      return c.json(
        {
          error:
            "Cannot delete skill because it is referenced by one or more agents",
        },
        409,
      );
    }

    await db
      .delete(skillTable)
      .where(
        and(
          eq(skillTable.id, skillId),
          eq(skillTable.workspaceId, workspaceId),
        ),
      );

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
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    const skillId = c.req.param("skillId");

    // Only a workspace-scoped Skill in this workspace can be promoted.
    const [existing] = await db
      .select()
      .from(skillTable)
      .where(
        and(
          eq(skillTable.id, skillId),
          eq(skillTable.workspaceId, workspaceId),
        ),
      )
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
          .where(
            and(
              eq(skillTable.id, skillId),
              eq(skillTable.workspaceId, workspaceId),
            ),
          )
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
    } catch (error: any) {
      if (error?.message === PROMOTE_RACE) {
        throw new NotFoundError("Skill not found");
      }
      // A duplicate Shared-Skill name surfaces as a Postgres unique violation,
      // mapped to 409 by the central onError (ADR-0009).
      throw error;
    }
  },
);

export { skill };
