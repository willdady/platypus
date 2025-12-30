import { tool } from "ai";
import { z } from "zod";
import { db } from "../index.ts";
import { skill as skillTable } from "../db/schema.ts";
import { and, eq } from "drizzle-orm";

export const createLoadSkillTool = (workspaceId: string) =>
  tool({
    description:
      "Load the full content of a skill by name. Use this when a user request relates to one of the available skills.",
    inputSchema: z.object({
      name: z.string().describe("The kebab-case name of the skill to load"),
    }),
    execute: async ({ name }: { name: string }) => {
      const [result] = await db
        .select()
        .from(skillTable)
        .where(
          and(
            eq(skillTable.workspaceId, workspaceId),
            eq(skillTable.name, name),
          ),
        )
        .limit(1);

      if (!result) {
        return { error: `Skill '${name}' not found` };
      }

      return { name: result.name, body: result.body };
    },
  });
