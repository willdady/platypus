import {
  resolveScopedByName,
  type Database,
  type RowOf,
} from "./scoped-resource.ts";

/**
 * What resolving a Skill *by name* against an Agent's assigned set came to.
 *
 * Three-valued rather than a nullable row because the two absences are not the
 * same answer: a name nothing resolves is a typo, a name that resolves to a
 * Skill this Agent was never given is a configuration mistake, and the model is
 * told which it was. `disableModelInvocation` is deliberately NOT read here —
 * it gates the *model's* catalogue (#713), and a user invoking the Skill from
 * the chat input is exactly the caller it must not stop.
 */
export type SkillResolution =
  | { kind: "resolved"; row: RowOf["skill"] }
  | { kind: "unassigned" }
  | { kind: "not-found" };

/**
 * The Skill of this name that `permittedSkillIds` may load, under the
 * Workspace-then-attached-Shared rule every scoped read follows (ADR-0007).
 *
 * Name resolution normally prefers the Workspace row. If that row is not in the
 * permitted set the lookup is retried *within* it, so an assigned Shared Skill
 * sharing a name with an unassigned Workspace one stays loadable rather than
 * being shadowed by a row the caller may not have.
 *
 * Shared by the model-facing `loadSkill` tool and the user-invoked slash
 * command, which differ only in what they do with the result — the retry above
 * is the non-obvious part, and one copy of it is what keeps the two paths
 * resolving the same name to the same body.
 */
export const resolveAssignedSkillByName = async (
  database: Database,
  name: string,
  ctx: { orgId: string; workspaceId: string },
  permittedSkillIds: string[],
): Promise<SkillResolution> => {
  const permitted = new Set(permittedSkillIds);

  let found = await resolveScopedByName(database, "skill", name, ctx);

  if (found && !permitted.has(found.row.id)) {
    found = await resolveScopedByName(
      database,
      "skill",
      name,
      ctx,
      permittedSkillIds,
    );
    if (!found) return { kind: "unassigned" };
  }

  if (!found) return { kind: "not-found" };
  if (!permitted.has(found.row.id)) return { kind: "unassigned" };
  return { kind: "resolved", row: found.row };
};
