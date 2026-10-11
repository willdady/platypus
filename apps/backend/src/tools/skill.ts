import { tool } from "ai";
import { z } from "zod";
import { db } from "../index.ts";
import { resolveAssignedSkillByName } from "../services/skill-resolution.ts";
import {
  findSkillFileByPath,
  readStoredSkillFile,
  skillLoadResult,
} from "../services/skill-bundle.ts";
import { normaliseBundlePath } from "../services/skill-bundle-format.ts";
import type { RowOf } from "../services/scoped-resource.ts";

/** The most `readSkillFile` returns from one file. */
export const SKILL_FILE_READ_MAX_BYTES = 1024 * 1024;

/**
 * The Skill of this name the model may use, or the `{ error }` it is told
 * instead. The Skill of this name visible here is the workspace-scoped one, or
 * the org-scoped (Shared) one where attached to this workspace (ADR-0007).
 * Resolution is shared with the user-invoked slash command; what is NOT shared
 * is the gate below — `disableModelInvocation` stops the model and only the
 * model (#713). Both Skill Tools pass through it, so a file is readable exactly
 * when its Skill is loadable.
 */
const resolveForModel = async (
  name: string,
  orgId: string,
  workspaceId: string,
  permittedSkillIds: string[],
): Promise<{ row: RowOf["skill"] } | { error: string }> => {
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
  return { row: resolution.row };
};

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
      const found = await resolveForModel(
        name,
        orgId,
        workspaceId,
        permittedSkillIds,
      );
      if ("error" in found) return found;
      return skillLoadResult(db, found.row);
    },
  });

export const createReadSkillFileTool = (
  orgId: string,
  workspaceId: string,
  permittedSkillIds: string[],
) =>
  tool({
    description:
      "Read a text file bundled with a skill. Use the paths loadSkill lists for the skill, relative to the skill's root.",
    inputSchema: z.object({
      name: z.string().describe("The kebab-case name of the skill"),
      path: z
        .string()
        .describe("The file's path relative to the skill's root, as listed"),
    }),
    execute: async ({ name, path }: { name: string; path: string }) => {
      const found = await resolveForModel(
        name,
        orgId,
        workspaceId,
        permittedSkillIds,
      );
      if ("error" in found) return found;

      let normalised: string;
      try {
        normalised = normaliseBundlePath(path);
      } catch (error) {
        return { error: (error as Error).message };
      }

      const file = await findSkillFileByPath(found.row.id, normalised);
      if (!file) {
        return { error: `Skill '${name}' has no file '${normalised}'` };
      }
      if (!file.isText) {
        return {
          error: `'${normalised}' is a binary file; using it needs a Sandbox`,
        };
      }
      if (file.size > SKILL_FILE_READ_MAX_BYTES) {
        return {
          error: `'${normalised}' is larger than the ${SKILL_FILE_READ_MAX_BYTES / 1024 / 1024} MiB readSkillFile limit`,
        };
      }

      const data = await readStoredSkillFile(file);
      if (!data) return { error: `'${normalised}' could not be read` };
      return { path: normalised, content: data.toString("utf8") };
    },
  });
