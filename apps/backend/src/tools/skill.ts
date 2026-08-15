import { tool } from "ai";
import { z } from "zod";
import { db } from "../index.ts";
import { resolveScopedByName } from "../services/scoped-resource.ts";

export const createLoadSkillTool = (orgId: string, workspaceId: string) =>
  tool({
    description:
      "Load the full content of a skill by name. Use this when a user request relates to one of the available skills.",
    inputSchema: z.object({
      name: z.string().describe("The kebab-case name of the skill to load"),
    }),
    execute: async ({ name }: { name: string }) => {
      // The Skill of this name visible here: the workspace-scoped one, or the
      // org-scoped (Shared) one where attached to this workspace (ADR-0007).
      const found = await resolveScopedByName(db, "skill", name, {
        orgId,
        wsId: workspaceId,
      });

      if (!found) {
        return { error: `Skill '${name}' not found` };
      }

      return { name: found.row.name, body: found.row.body };
    },
  });
