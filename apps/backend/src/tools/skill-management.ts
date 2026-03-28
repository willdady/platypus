import { tool, type Tool } from "ai";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../index.ts";
import { skill as skillTable, agent as agentTable } from "../db/schema.ts";

const skillNameRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function createSkillManagementTools(
  workspaceId: string,
): Record<string, Tool> {
  const listSkills = tool({
    description: "List all skills in the current workspace.",
    inputSchema: z.object({}),
    execute: async () => {
      const skills = await db
        .select({
          id: skillTable.id,
          name: skillTable.name,
          description: skillTable.description,
          createdAt: skillTable.createdAt,
          updatedAt: skillTable.updatedAt,
        })
        .from(skillTable)
        .where(eq(skillTable.workspaceId, workspaceId));
      return skills;
    },
  });

  const getSkill = tool({
    description: "Get the full content of a skill by name.",
    inputSchema: z.object({
      name: z.string().describe("The name of the skill to retrieve"),
    }),
    execute: async ({ name }) => {
      const result = await db
        .select()
        .from(skillTable)
        .where(
          and(
            eq(skillTable.workspaceId, workspaceId),
            eq(skillTable.name, name),
          ),
        )
        .limit(1);

      if (result.length === 0) {
        return { error: "Skill not found" };
      }

      return result[0];
    },
  });

  const upsertSkill = tool({
    description:
      "Create a new skill or update an existing skill by name. If a skill with the given name already exists in this workspace, it will be updated.",
    inputSchema: z.object({
      name: z
        .string()
        .min(5)
        .max(64)
        .regex(skillNameRegex, "Skill name must be kebab-case"),
      description: z.string().min(24).max(128),
      body: z.string().min(48).max(5000),
    }),
    execute: async ({ name, description, body }) => {
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

      return record[0];
    },
  });

  const deleteSkill = tool({
    description:
      "Delete a skill by name. Will fail if the skill is referenced by one or more agents.",
    inputSchema: z.object({
      name: z.string().describe("The name of the skill to delete"),
    }),
    execute: async ({ name }) => {
      const existing = await db
        .select({ id: skillTable.id })
        .from(skillTable)
        .where(
          and(
            eq(skillTable.workspaceId, workspaceId),
            eq(skillTable.name, name),
          ),
        )
        .limit(1);

      if (existing.length === 0) {
        return { error: "Skill not found" };
      }

      const skillId = existing[0].id;

      // Check if any agents reference this skill
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
