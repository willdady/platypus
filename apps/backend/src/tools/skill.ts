import { tool } from "ai";
import { z } from "zod";
import { db } from "../index.ts";
import {
  skill as skillTable,
  attachment as attachmentTable,
} from "../db/schema.ts";
import { and, eq } from "drizzle-orm";

export const createLoadSkillTool = (orgId: string, workspaceId: string) =>
  tool({
    description:
      "Load the full content of a skill by name. Use this when a user request relates to one of the available skills.",
    inputSchema: z.object({
      name: z.string().describe("The kebab-case name of the skill to load"),
    }),
    execute: async ({ name }: { name: string }) => {
      // A workspace-scoped Skill in this workspace.
      const [workspaceSkill] = await db
        .select()
        .from(skillTable)
        .where(
          and(
            eq(skillTable.workspaceId, workspaceId),
            eq(skillTable.name, name),
          ),
        )
        .limit(1);

      if (workspaceSkill) {
        return { name: workspaceSkill.name, body: workspaceSkill.body };
      }

      // Otherwise an org-scoped (Shared) Skill, resolved only where attached
      // to the invoking workspace (ADR-0007).
      const [orgSkill] = await db
        .select({ name: skillTable.name, body: skillTable.body })
        .from(skillTable)
        .innerJoin(
          attachmentTable,
          and(
            eq(attachmentTable.resourceId, skillTable.id),
            eq(attachmentTable.resourceType, "skill"),
            eq(attachmentTable.workspaceId, workspaceId),
          ),
        )
        .where(
          and(eq(skillTable.organizationId, orgId), eq(skillTable.name, name)),
        )
        .limit(1);

      if (!orgSkill) {
        return { error: `Skill '${name}' not found` };
      }

      return { name: orgSkill.name, body: orgSkill.body };
    },
  });
