import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { skill as skillTable, agent as agentTable } from "../db/schema.ts";
import { skillCreateSchema, skillUpdateSchema } from "@platypus/schemas";
import { eq, and, sql, inArray, notInArray } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

const skill = new Hono<{ Variables: Variables }>();

/** List all skills in workspace */
skill.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const results = await db
      .select()
      .from(skillTable)
      .where(eq(skillTable.workspaceId, workspaceId));

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
    const workspaceId = c.req.param("workspaceId")!;
    const skillId = c.req.param("skillId");

    const record = await db
      .select()
      .from(skillTable)
      .where(
        and(
          eq(skillTable.id, skillId),
          eq(skillTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (record.length === 0) {
      return c.json({ error: "Skill not found" }, 404);
    }

    // Find agents that have this skill assigned
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
      ...record[0],
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
    const { agentIds, ...data } = c.req.valid("json");
    try {
      const newId = nanoid();
      const record = await db
        .insert(skillTable)
        .values({
          id: newId,
          ...data,
        })
        .returning();

      // Add skill to specified agents
      if (agentIds && agentIds.length > 0) {
        const workspaceId = c.req.param("workspaceId")!;
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
    } catch (error: any) {
      const isUniqueViolation =
        error.code === "23505" ||
        error.cause?.code === "23505" ||
        error.message?.includes("unique constraint") ||
        error.cause?.message?.includes("unique constraint");

      if (isUniqueViolation) {
        return c.json(
          {
            error: "A skill with this name already exists in this workspace",
          },
          409,
        );
      }
      throw error;
    }
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
    const workspaceId = c.req.param("workspaceId")!;
    const skillId = c.req.param("skillId");
    const { agentIds, ...data } = c.req.valid("json");

    try {
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

      if (record.length === 0) {
        return c.json({ error: "Skill not found" }, 404);
      }

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
    } catch (error: any) {
      const isUniqueViolation =
        error.code === "23505" ||
        error.cause?.code === "23505" ||
        error.message?.includes("unique constraint") ||
        error.cause?.message?.includes("unique constraint");

      if (isUniqueViolation) {
        return c.json(
          {
            error: "A skill with this name already exists in this workspace",
          },
          409,
        );
      }
      throw error;
    }
  },
);

/** Delete a skill by ID (editor+) */
skill.delete(
  "/:skillId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const skillId = c.req.param("skillId");

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

    const result = await db
      .delete(skillTable)
      .where(
        and(
          eq(skillTable.id, skillId),
          eq(skillTable.workspaceId, workspaceId),
        ),
      )
      .returning();

    if (result.length === 0) {
      return c.json({ error: "Skill not found" }, 404);
    }

    return c.json({ message: "Skill deleted" });
  },
);

export { skill };
