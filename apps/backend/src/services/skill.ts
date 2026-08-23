import type { z } from "zod";
import type { SQL } from "drizzle-orm";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { skill as skillTable, agent as agentTable } from "../db/schema.ts";
import { skillCreateSchema, skillUpdateSchema } from "@platypus/schemas";
import type { ScopeContext } from "../scope.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { scrubDeletedAgentReference } from "./agent-references.ts";
import {
  orgScopedWhere,
  requireOrgScoped,
  requireSharedDeletable,
  requireWorkspaceMutable,
  workspaceScopedWhere,
} from "./scoped-resource.ts";

/**
 * The Skill write model: create/update/delete that both route surfaces adapt
 * over — `routes/skill.ts` (Workspace surface) and `routes/org-skill.ts`
 * (Organization surface). They used to each carry a verbatim copy of the
 * insert/update column set (name/description/body) and the agent-association
 * SQL and had already drifted apart (#605): the Workspace copy owns `agentIds`
 * while the Organization copy re-lists the fields to discard them.
 *
 * `updateSkill`/`deleteSkill` also answer the agent-facing Tool surface
 * (`tools/skill-management.ts`), which catches the typed errors and translates
 * them to an `{ error }` result instead of letting them bubble to an HTTP
 * `onError`.
 *
 * "Not visible here" and "visible but locked" (a Shared Skill, a single source
 * of truth edited only on the Organization surface — ADR-0007) are the
 * cross-cutting errors of ADR-0010: at Workspace scope they throw via
 * `requireWorkspaceMutable`, letting the routes bubble to `app.onError` and the
 * Tool catch and translate. At Organization scope, "not visible here" throws
 * `NotFoundError` via `requireOrgScoped`/`requireSharedDeletable` the same way;
 * there is no "locked" case, since the Organization surface is where a Shared
 * Skill is always editable.
 */

export type SkillRow = typeof skillTable.$inferSelect;

/** The fields a create carries — every field but the id and its scope. */
export type SkillCreateFields = Omit<
  z.infer<typeof skillCreateSchema>,
  "organizationId" | "workspaceId"
>;

/** The fields an update may carry — a partial edit of the same set. */
export type SkillUpdateFields = z.infer<typeof skillUpdateSchema>;

/**
 * Which scope a write targets — the Workspace surface (ADR-0006 delegation
 * applies, a Shared row is locked) or the Organization surface (admin-only,
 * writes a Shared row directly). The one write model answers both surfaces by
 * branching on this rather than existing twice. Mirrors `ProviderScope`.
 */
export type SkillScope =
  | { kind: "workspace"; ctx: ScopeContext }
  | { kind: "organization"; orgId: string };

/** Appends `skillId` to `agentIds`' skill lists where it is not already set. */
const assignToAgents = async (
  workspaceId: string,
  skillId: string,
  agentIds: string[],
): Promise<void> => {
  if (agentIds.length === 0) return;
  const skillIdJson = JSON.stringify([skillId]);
  await db
    .update(agentTable)
    .set({
      skillIds: sql`${agentTable.skillIds} || ${skillIdJson}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentTable.workspaceId, workspaceId),
        inArray(agentTable.id, agentIds),
        sql`NOT ${agentTable.skillIds} @> ${skillIdJson}::jsonb`,
      ),
    );
};

/**
 * Rewrites a Skill's agent set: removes the Skill from every Workspace agent
 * not in the new list, then appends it to the ones that are. Runs only when an
 * update carries `agentIds`; the field's undefined/null distinction is what
 * separates "clear the set" from "leave it alone".
 */
const syncAgentAssignments = async (
  workspaceId: string,
  skillId: string,
  agentIds: string[],
): Promise<void> => {
  const now = new Date();
  const skillIdJson = JSON.stringify([skillId]);

  // Remove skill from agents not in the new list.
  const removeWhere = [
    eq(agentTable.workspaceId, workspaceId),
    sql`${agentTable.skillIds} @> ${skillIdJson}::jsonb`,
  ];
  if (agentIds.length > 0) {
    removeWhere.push(notInArray(agentTable.id, agentIds));
  }
  await db
    .update(agentTable)
    .set({
      skillIds: sql`(${agentTable.skillIds})::jsonb - ${skillId}::text`,
      updatedAt: now,
    })
    .where(and(...removeWhere));

  await assignToAgents(workspaceId, skillId, agentIds);
};

/**
 * Creates a new Skill at the given scope. The scope comes from `scope`, never
 * the body — a caller cannot mint a Shared Skill from the Workspace surface by
 * naming an `organizationId` in the request (ADR-0006, ADR-0007). Agent
 * associations are a Workspace concern; at Organization scope any `agentIds`
 * are ignored, matching what the org surface used to do explicitly. A duplicate
 * name surfaces as a Postgres unique violation, mapped to 409 by the central
 * `onError` (ADR-0010).
 */
export async function createSkill(
  scope: SkillScope,
  fields: SkillCreateFields,
): Promise<SkillRow> {
  const { agentIds, ...data } = fields;

  const [row] = await db
    .insert(skillTable)
    .values({
      id: nanoid(),
      ...data,
      ...(scope.kind === "workspace"
        ? { workspaceId: scope.ctx.workspaceId, organizationId: null }
        : { organizationId: scope.orgId, workspaceId: null }),
    })
    .returning();

  if (scope.kind === "workspace" && agentIds) {
    await assignToAgents(scope.ctx.workspaceId, row.id, agentIds);
  }
  return row;
}

/**
 * Updates a Skill at the given scope. Throws `NotFoundError` when the Skill is
 * not visible at this scope, and (Workspace scope only) `LockedError` when it
 * is a Shared Skill edited only on the Organization surface (ADR-0007). A
 * duplicate name surfaces as a Postgres unique violation, mapped to 409 by the
 * central `onError` (ADR-0010).
 */
export async function updateSkill(
  scope: SkillScope,
  skillId: string,
  fields: SkillUpdateFields,
): Promise<SkillRow> {
  const { agentIds, ...data } = fields;

  let where: SQL;
  if (scope.kind === "workspace") {
    // A Shared Skill is a single source of truth edited only on the
    // Organization surface (ADR-0007); requireWorkspaceMutable throws
    // NotFound (→404) when the Skill is not visible here, then Locked (→403)
    // when it is org-scoped.
    await requireWorkspaceMutable(db, "skill", skillId, scope.ctx);
    where = workspaceScopedWhere("skill", skillId, scope.ctx.workspaceId);
  } else {
    // The existence check the Organization surface used to defer to an empty
    // UPDATE result (#605): requireOrgScoped throws NotFound (→404) before the
    // write ever runs.
    await requireOrgScoped(db, "skill", skillId, scope.orgId);
    where = orgScopedWhere("skill", skillId, scope.orgId);
  }

  const [row] = await db
    .update(skillTable)
    .set({ ...data, updatedAt: new Date() })
    .where(where)
    .returning();

  // The pre-checks above prove the row exists, but a concurrent delete can still
  // win the race between the check and the UPDATE; the Organization surface
  // reports that as the 404 it always did, rather than an empty 200.
  if (scope.kind === "organization" && !row) {
    throw new NotFoundError("Skill not found");
  }

  if (scope.kind === "workspace" && agentIds !== undefined) {
    await syncAgentAssignments(scope.ctx.workspaceId, skillId, agentIds);
  }
  return row;
}

/**
 * Creates or overwrites the Workspace's own version of a Skill in one statement
 * — the agent-facing Tool's write (it addresses Skills by name, no id). The
 * conflict target is `(workspaceId, name)`, which is what keeps the write
 * Workspace-private: reusing the name of an attached Shared Skill creates this
 * Workspace's own version rather than editing the Organization's row. The scope
 * comes from `ctx`, never the body.
 */
export async function upsertSkill(
  ctx: ScopeContext,
  fields: { name: string; description: string; body: string },
): Promise<SkillRow> {
  const now = new Date();
  const [row] = await db
    .insert(skillTable)
    .values({
      id: nanoid(),
      workspaceId: ctx.workspaceId,
      name: fields.name,
      description: fields.description,
      body: fields.body,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [skillTable.workspaceId, skillTable.name],
      set: {
        description: fields.description,
        body: fields.body,
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

/**
 * Deletes a Skill at the given scope. At Workspace scope, throws
 * `NotFoundError`/`LockedError` (via `requireWorkspaceMutable`) under the same
 * rule as {@link updateSkill}, and `ConflictError` while a Workspace agent
 * still references the Skill. At Organization scope, throws `ConflictError`
 * (via `requireSharedDeletable`) while an Attachment or Blueprint still
 * references the Skill (ADR-0007/0008), and — because deleting a Shared Skill
 * can orphan an Agent's `skillIds` reference to it — scrubs that reference in
 * the same transaction as the delete.
 */
export async function deleteSkill(
  scope: SkillScope,
  skillId: string,
): Promise<void> {
  if (scope.kind === "workspace") {
    await requireWorkspaceMutable(db, "skill", skillId, scope.ctx);

    // A Skill that still names this Workspace's agents is still in use; refuse
    // rather than leave dangling references.
    const referencingAgents = await db
      .select({ id: agentTable.id })
      .from(agentTable)
      .where(
        and(
          eq(agentTable.workspaceId, scope.ctx.workspaceId),
          sql`${agentTable.skillIds} @> ${JSON.stringify([skillId])}::jsonb`,
        ),
      )
      .limit(1);
    if (referencingAgents.length > 0) {
      throw new ConflictError(
        "Cannot delete skill because it is referenced by one or more agents",
      );
    }

    await db
      .delete(skillTable)
      .where(workspaceScopedWhere("skill", skillId, scope.ctx.workspaceId));
    return;
  }

  // A Shared resource cannot be deleted while anything still points at it —
  // an Attachment (ADR-0007) or a Blueprint (ADR-0008). Throws ConflictError
  // → 409 via the central onError (ADR-0010).
  await requireSharedDeletable(db, "skill", skillId);

  // Delete the Skill and scrub its (now-dead) id from any Agent's skillIds in
  // the same transaction, so deletion never leaves a dangling reference.
  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(skillTable)
      .where(orgScopedWhere("skill", skillId, scope.orgId))
      .returning();
    if (rows.length > 0) {
      await scrubDeletedAgentReference(tx, "skillIds", skillId);
    }
    return rows;
  });
  if (result.length === 0) {
    throw new NotFoundError("Skill not found");
  }
}
