import { nanoid } from "nanoid";
import type { z } from "zod";
import type { agentBaseSchema } from "@platypus/schemas";
import { db } from "../index.ts";
import { agent as agentTable } from "../db/schema.ts";
import { dedupeArray } from "../utils.ts";
import type { ScopeContext } from "../scope.ts";
import {
  validateSubAgentAssignment,
  SUB_AGENT_SELF_ASSIGNMENT_ERROR,
} from "./sub-agent-validation.ts";
import {
  findNonSharedReferences,
  type ReferenceBlocker,
} from "./agent-scope-validation.ts";
import { scrubDeletedAgentReference } from "./agent-references.ts";
import { NotFoundError } from "../errors.ts";
import {
  orgScopedWhere,
  requireOrgScoped,
  requireSharedDeletable,
  requireWorkspaceMutable,
  workspaceScopedWhere,
} from "./scoped-resource.ts";
import { deleteAvatar } from "./avatar.ts";

/**
 * The Agent write model: dedupe, sub-agent validation, and the
 * insert/update/delete (with avatar cleanup) both surfaces need. The HTTP
 * routes and the Agent-management Tool set are adapters over it — they parse
 * and authorize their own input, call in here, and shape the result. The two
 * used to carry a copy each and had already drifted apart: the Tool's copy of
 * the sampling params was non-nullable, so an Agent could not clear a
 * temperature it had set, while the route's schema-driven copy could (#263).
 *
 * `updateAgent`/`deleteAgent` also answer the Organization surface
 * (`routes/org-agent.ts`), which used to carry its own copy of the dedupe,
 * self-assignment check, and `findNonSharedReferences` blockers inline (#605).
 *
 * "Not visible here" and "visible but locked" (a Shared Agent, a single
 * source of truth edited only on the Organization surface — ADR-0007) are the
 * cross-cutting errors of ADR-0010: at Workspace scope, `updateAgent`/
 * `deleteAgent` throw them via `requireWorkspaceMutable`, for the route to let
 * bubble to `app.onError` and the Tool to catch and translate to an `{ error
 * }` result. At Organization scope, "not visible here" throws `NotFoundError`
 * via `requireOrgScoped`/`requireSharedDeletable` the same way; there is no
 * "locked" case, since the Organization surface is where a Shared Agent is
 * always editable. A rejected sub-agent assignment or reference-blocker check
 * is surface-specific validation (errors.ts) and so answers inline instead, as
 * `{ error }`.
 */

type AgentRow = typeof agentTable.$inferSelect;

/** The fields a create carries — every field but the id and its scope. */
export type AgentCreateFields = Omit<
  z.infer<typeof agentBaseSchema>,
  | "id"
  | "organizationId"
  | "workspaceId"
  | "avatarUrl"
  | "createdAt"
  | "updatedAt"
>;

/** The fields an update may carry — a partial edit of the same set. */
export type AgentUpdateFields = Partial<AgentCreateFields>;

/**
 * What a rejected write carries — shared with the Tool adapter's own result
 * shape. `blockers` is present only for an Organization-scope rejection: the
 * Agent references a Workspace-private resource a Shared Agent may not
 * reference (ADR-0007), named so the UI can render a fix-this checklist.
 */
export type AgentWriteError = { error: string; blockers?: ReferenceBlocker[] };

export type AgentWriteResult = { row: AgentRow } | AgentWriteError;

/**
 * Which scope a write targets — the Workspace surface (ADR-0006 delegation
 * applies, a Shared row is locked) or the Organization surface (admin-only,
 * writes a Shared row directly). Mirrors `ProviderScope`.
 */
export type AgentScope =
  | { kind: "workspace"; ctx: ScopeContext }
  | { kind: "organization"; orgId: string };

/** The id-array fields both a create and an update may carry, for deduping. */
type IdArrayFields = Pick<
  AgentUpdateFields,
  "toolSetIds" | "skillIds" | "subAgentIds"
>;

/** Dedupes the id arrays a write may carry; fields with none pass through unchanged. */
const dedupeIdArrays = <T extends IdArrayFields>(fields: T): T => ({
  ...fields,
  ...(fields.toolSetIds && { toolSetIds: dedupeArray(fields.toolSetIds) }),
  ...(fields.skillIds && { skillIds: dedupeArray(fields.skillIds) }),
  ...(fields.subAgentIds && {
    subAgentIds: dedupeArray(fields.subAgentIds),
  }),
});

/**
 * Creates a new Workspace-scoped Agent. The Workspace comes from `ctx`, never
 * the body — a Workspace surface only ever creates Workspace-scoped Agents
 * (org-scoped Agents arrive via Promote).
 */
export async function createAgent(
  ctx: ScopeContext,
  fields: AgentCreateFields,
): Promise<AgentWriteResult> {
  const data = dedupeIdArrays(fields);
  const id = nanoid();

  if (data.subAgentIds && data.subAgentIds.length > 0) {
    const validation = await validateSubAgentAssignment(
      ctx,
      id,
      data.subAgentIds,
    );
    if (!validation.valid) {
      return { error: validation.error! };
    }
  }

  const [row] = await db
    .insert(agentTable)
    .values({
      id,
      ...data,
      workspaceId: ctx.workspaceId,
      organizationId: null,
    })
    .returning();
  return { row };
}

/**
 * Updates an Agent at the given scope. At Workspace scope, throws
 * `NotFoundError`/`LockedError` (via `requireWorkspaceMutable`) when the Agent
 * is not visible here or is a Shared Agent edited only on the Organization
 * surface (ADR-0007), then validates `subAgentIds` against what this
 * Workspace can see. At Organization scope, throws `NotFoundError` (via
 * `requireOrgScoped`) when the Agent is not visible, then rejects with
 * `blockers` when the update would leave a Shared Agent referencing a
 * Workspace-private resource (ADR-0007's no-cascade rule).
 */
export async function updateAgent(
  scope: AgentScope,
  agentId: string,
  fields: AgentUpdateFields,
): Promise<AgentWriteResult> {
  const data = dedupeIdArrays(fields);

  if (scope.kind === "workspace") {
    await requireWorkspaceMutable(db, "agent", agentId, scope.ctx);

    if (data.subAgentIds) {
      const validation = await validateSubAgentAssignment(
        scope.ctx,
        agentId,
        data.subAgentIds,
      );
      if (!validation.valid) {
        return { error: validation.error! };
      }
    }

    const [row] = await db
      .update(agentTable)
      .set({ ...data, updatedAt: new Date() })
      .where(workspaceScopedWhere("agent", agentId, scope.ctx.workspaceId))
      .returning();
    return { row };
  }

  await requireOrgScoped(db, "agent", agentId, scope.orgId);

  if (data.subAgentIds?.includes(agentId)) {
    return { error: SUB_AGENT_SELF_ASSIGNMENT_ERROR };
  }

  // A Shared Agent may reference only other Shared resources (ADR-0007).
  // `providerId` is required by `agentUpdateSchema` on this surface (unlike
  // the Workspace surface's Tool adapter, which allows a partial update), so
  // it is always present here despite `AgentUpdateFields` widening it to
  // optional for that other caller.
  const blockers = await findNonSharedReferences(scope.orgId, {
    providerId: data.providerId!,
    skillIds: data.skillIds,
    subAgentIds: data.subAgentIds,
    toolSetIds: data.toolSetIds,
  });
  if (blockers.length > 0) {
    return {
      error:
        "A shared agent may only reference other shared (organization-scoped) resources",
      blockers,
    };
  }

  const [row] = await db
    .update(agentTable)
    .set({ ...data, updatedAt: new Date() })
    .where(orgScopedWhere("agent", agentId, scope.orgId))
    .returning();
  return { row };
}

/**
 * Deletes an Agent at the given scope, cleaning up its avatar. At Workspace
 * scope, throws `NotFoundError`/`LockedError` (via `requireWorkspaceMutable`)
 * under the same rule as {@link updateAgent}. At Organization scope, throws
 * `ConflictError` (via `requireSharedDeletable`) while an Attachment or
 * Blueprint still references the Agent (ADR-0007/0008), and — because
 * deleting a Shared Agent can orphan another Agent's `subAgentIds` reference
 * to it — scrubs that reference in the same transaction as the delete.
 */
export async function deleteAgent(
  scope: AgentScope,
  agentId: string,
): Promise<void> {
  if (scope.kind === "workspace") {
    const found = await requireWorkspaceMutable(
      db,
      "agent",
      agentId,
      scope.ctx,
    );

    await deleteAvatar(found.row.avatarKey);

    await db
      .delete(agentTable)
      .where(workspaceScopedWhere("agent", agentId, scope.ctx.workspaceId));
    return;
  }

  await requireSharedDeletable(db, "agent", agentId);

  // requireSharedDeletable only checks referencing Attachments/Blueprints, not
  // existence, so the delete itself is where a missing Agent 404s.
  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(agentTable)
      .where(orgScopedWhere("agent", agentId, scope.orgId))
      .returning();
    if (rows.length > 0) {
      await scrubDeletedAgentReference(tx, "subAgentIds", agentId);
    }
    return rows;
  });
  if (result.length === 0) {
    throw new NotFoundError("Agent not found");
  }

  // Best-effort: a storage miss must not fail the delete that already committed.
  await deleteAvatar(result[0].avatarKey);
}
