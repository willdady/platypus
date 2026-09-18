import { tool } from "ai";
import { z } from "zod";
import { db } from "../index.ts";
import { resolveAssignedSkillByName } from "../services/skill-resolution.ts";

export const createLoadSkillTool = (
  orgId: string,
  workspaceId: string,
  permittedSkillIds: string[],
) =>
  tool({
    description:
      "Load the full content of a skill by name. Use this when a user request relates to one of the available skills.",
    inputSchema: z.object({
      name: z.string().describe("The kebab-case name of the skill to load"),
    }),
    execute: async ({ name }: { name: string }) => {
      // The Skill of this name visible here: the workspace-scoped one, or the
      // org-scoped (Shared) one where attached to this workspace (ADR-0007).
      // Resolution is shared with the user-invoked slash command; what is NOT
      // shared is the gate below — `disableModelInvocation` stops the model and
      // only the model (#713).
      const resolution = await resolveAssignedSkillByName(
        db,
        name,
        { orgId, workspaceId },
        permittedSkillIds,
      );

      if (resolution.kind === "unassigned") {
        return { error: `Skill '${name}' is not assigned to this agent` };
      }
      if (resolution.kind === "not-found") {
        return { error: `Skill '${name}' not found` };
      }
      if (resolution.row.disableModelInvocation) {
        return { error: `Skill '${name}' can only be invoked by a user` };
      }

      return { name: resolution.row.name, body: resolution.row.body };
    },
  });
