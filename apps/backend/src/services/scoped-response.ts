import type {
  AgentResponse,
  ResourceScope,
  SkillResponse,
} from "@platypus/schemas";
import type { agent as agentTable, skill as skillTable } from "../db/schema.ts";
import { avatarKeyToUrl } from "../utils/avatar-url.ts";

/**
 * The response shape of a Scoped resource's non-secret fields.
 *
 * `scope` is part of the shape, never an optional add-on: a Workspace list
 * resolves each row at its own scope, and the Organization surface passes
 * `"organization"` because every row there is Organization-scoped by
 * construction. One helper per resource keeps every route — list, detail,
 * write, Promote — answering with the same keys.
 */

/** An Agent as every Agent route returns one, with its stored avatar key resolved. */
export const agentResponse = (
  row: typeof agentTable.$inferSelect,
  scope: ResourceScope,
  baseUrl: string,
): AgentResponse => {
  const { avatarKey, ...rest } = row;
  // The response schema keeps the create shape's optional fields; a stored row
  // spells "unset" as `null`, which both read the same in the UI.
  return {
    ...rest,
    avatarUrl: avatarKeyToUrl(avatarKey, baseUrl) ?? undefined,
    scope,
  } as AgentResponse;
};

/** A Skill as every Skill route returns one. */
export const skillResponse = (
  row: typeof skillTable.$inferSelect,
  scope: ResourceScope,
): SkillResponse =>
  // `sourceType` is a text column; the import paths narrow it to `"github"`.
  ({ ...row, scope }) as SkillResponse;
