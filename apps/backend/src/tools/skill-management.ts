import { tool, type Tool } from "ai";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { skillBaseSchema } from "@platypus/schemas";
import { db } from "../index.ts";
import { skill as skillTable, agent as agentTable } from "../db/schema.ts";
import { buildResourceUrl } from "../utils/resource-url.ts";
import {
  listScoped,
  resolveScopedByName,
  workspaceMutationLockedMessage,
} from "../services/scoped-resource.ts";
import type { ScopeContext } from "../scope.ts";

// Field constraints come from the shared schema so the agent-facing tool can
// never drift from the bounds the HTTP routes and the web form enforce.
const skillFields = skillBaseSchema.shape;

/**
 * Reads here resolve at the invoking Workspace's scope — its own Skills plus the
 * Shared ones attached to it (ADR-0007) — so the model sees the same Skills the
 * Operator does. Writes stay Workspace-private: a Shared Skill is a single
 * source of truth edited only on the Organization surface, so `deleteSkill`
 * refuses one, and `upsertSkill` writes this Workspace's own version instead of
 * reaching the Organization's row.
 */
export function createSkillManagementTools(
  workspaceId: string,
  orgId: string,
  frontendUrl: string | undefined,
): Record<string, Tool> {
  const ctx: ScopeContext = { orgId, workspaceId };

  const listSkills = tool({
    description:
      "List the skills available in the current workspace, including shared skills attached to it. A skill with scope 'organization' is shared and cannot be edited or deleted here.",
    inputSchema: z.object({}),
    execute: async () => {
      const scoped = await listScoped(db, "skill", ctx);
      return scoped.map(({ row, scope }) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        scope,
      }));
    },
  });

  const getSkill = tool({
    description: "Get the full content of a skill by name.",
    inputSchema: z.object({
      name: z.string().describe("The name of the skill to retrieve"),
    }),
    execute: async ({ name }) => {
      const found = await resolveScopedByName(db, "skill", name, ctx);

      if (!found) {
        return { error: "Skill not found" };
      }

      const url = buildResourceUrl(
        frontendUrl,
        orgId,
        workspaceId,
        `skills/${found.row.id}`,
      );

      return { ...found.row, scope: found.scope, ...(url && { url }) };
    },
  });

  const upsertSkill = tool({
    description:
      "Create a new skill or update an existing skill by name. If a skill with the given name already exists in this workspace, it will be updated. Using the name of a shared skill creates this workspace's own version of it — the organization's skill is left untouched.",
    inputSchema: z.object({
      name: skillFields.name.describe(
        "Kebab-case name of the skill, unique within the workspace",
      ),
      description: skillFields.description.describe(
        "Short summary of what the skill does and when to use it",
      ),
      body: skillFields.body.describe("The Markdown content of the skill"),
    }),
    execute: async ({ name, description, body }) => {
      // Writes only ever land on a workspace-scoped row: the conflict target is
      // `(workspaceId, name)`, so upserting the name of an attached Shared Skill
      // creates this Workspace's own version of it rather than editing the
      // Organization's. `resolveScopedByName` then prefers that local row, which
      // is what makes the override take effect.
      const { nanoid } = await import("nanoid");
      const now = new Date();

      const record = await db
        .insert(skillTable)
        .values({
          id: nanoid(),
          workspaceId,
          name,
          description,
          body,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [skillTable.workspaceId, skillTable.name],
          set: {
            description,
            body,
            updatedAt: now,
          },
        })
        .returning();

      const url = buildResourceUrl(
        frontendUrl,
        orgId,
        workspaceId,
        `skills/${record[0].id}`,
      );

      return { ...record[0], ...(url && { url }) };
    },
  });

  const deleteSkill = tool({
    description:
      "Delete a skill by name. Will fail if the skill is referenced by one or more agents, or if it is a shared skill managed at the organization level.",
    inputSchema: z.object({
      name: z.string().describe("The name of the skill to delete"),
    }),
    execute: async ({ name }) => {
      const existing = await resolveScopedByName(db, "skill", name, ctx);

      if (!existing) {
        return { error: "Skill not found" };
      }
      // Visible here, but a single source of truth deleted only on the
      // Organization surface (ADR-0007) — detaching it is the workspace-side
      // action, and that is an Attachment concern, not a delete.
      if (existing.scope === "organization") {
        return { error: workspaceMutationLockedMessage("skill") };
      }

      const skillId = existing.row.id;

      const referencingAgents = await db
        .select({ id: agentTable.id })
        .from(agentTable)
        .where(
          and(
            eq(agentTable.workspaceId, workspaceId),
            sql`${agentTable.skillIds} @> ${JSON.stringify([skillId])}::jsonb`,
          ),
        )
        .limit(1);

      if (referencingAgents.length > 0) {
        return {
          error:
            "Cannot delete skill because it is referenced by one or more agents",
        };
      }

      await db
        .delete(skillTable)
        .where(
          and(
            eq(skillTable.id, skillId),
            eq(skillTable.workspaceId, workspaceId),
          ),
        );

      return { success: true };
    },
  });

  return {
    listSkills,
    getSkill,
    upsertSkill,
    deleteSkill,
  };
}
