import {
  resolveScopedByName,
  type Database,
  type RowOf,
} from "./scoped-resource.ts";

export type SkillResolution =
  | { kind: "resolved"; row: RowOf["skill"] }
  | { kind: "unassigned" }
  | { kind: "not-found" };

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
