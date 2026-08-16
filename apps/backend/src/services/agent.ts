import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { z } from "zod";
import type { agentBaseSchema } from "@platypus/schemas";
import { db } from "../index.ts";
import { agent as agentTable } from "../db/schema.ts";
import { dedupeArray } from "../utils.ts";
import type { ScopeContext } from "../scope.ts";
import { validateSubAgentAssignment } from "./sub-agent-validation.ts";
import { requireWorkspaceMutable } from "./scoped-resource.ts";
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
 * "Not visible here" and "visible but locked" (a Shared Agent, a single
 * source of truth edited only on the Organization surface — ADR-0007) are the
 * cross-cutting errors of ADR-0010: `updateAgent`/`deleteAgent` throw them via
 * `requireWorkspaceMutable`, for the route to let bubble to `app.onError` and
 * the Tool to catch and translate to an `{ error }` result. A rejected
 * sub-agent assignment is surface-specific validation (errors.ts) and so
 * answers inline instead, as `{ error }`.
 */

export type AgentRow = typeof agentTable.$inferSelect;

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

/** What a rejected write carries — shared with the Tool adapter's own result shape. */
export type AgentWriteError = { error: string };

export type AgentWriteResult = { row: AgentRow } | AgentWriteError;

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
 * Updates a Workspace-scoped Agent. Throws `NotFoundError`/`LockedError` (via
 * `requireWorkspaceMutable`) when the Agent is not visible here or is a
 * Shared Agent edited only on the Organization surface (ADR-0007).
 */
export async function updateAgent(
  ctx: ScopeContext,
  agentId: string,
  fields: AgentUpdateFields,
): Promise<AgentWriteResult> {
  const data = dedupeIdArrays(fields);

  await requireWorkspaceMutable(db, "agent", agentId, ctx);

  if (data.subAgentIds) {
    const validation = await validateSubAgentAssignment(
      ctx,
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
    .where(
      and(
        eq(agentTable.id, agentId),
        eq(agentTable.workspaceId, ctx.workspaceId),
      ),
    )
    .returning();
  return { row };
}

/**
 * Deletes a Workspace-scoped Agent, cleaning up its avatar. Throws
 * `NotFoundError`/`LockedError` (via `requireWorkspaceMutable`) under the same
 * rule as {@link updateAgent}.
 */
export async function deleteAgent(
  ctx: ScopeContext,
  agentId: string,
): Promise<void> {
  const found = await requireWorkspaceMutable(db, "agent", agentId, ctx);

  await deleteAvatar(found.row.avatarKey);

  await db
    .delete(agentTable)
    .where(
      and(
        eq(agentTable.id, agentId),
        eq(agentTable.workspaceId, ctx.workspaceId),
      ),
    );
}
