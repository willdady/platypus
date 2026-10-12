import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import { workspaceAgentPin as pinTable } from "../db/schema.ts";
import type { ScopeContext } from "../scope.ts";
import { requireScoped } from "./scoped-resource.ts";

/**
 * Pinned Agents: a per-Workspace pin, set by the Workspace Owner, that lifts
 * an Agent above the rest wherever the Workspace lists its Agents. Only an
 * Agent visible in the Workspace — its own, or an attached Shared one — can be
 * pinned; anything else is `NotFoundError` (→404). Both writes are idempotent.
 */

/** The ids of the Agents pinned in a Workspace. */
export const pinnedAgentIds = async (
  workspaceId: string,
): Promise<Set<string>> => {
  const rows = await db
    .select({ agentId: pinTable.agentId })
    .from(pinTable)
    .where(eq(pinTable.workspaceId, workspaceId));
  return new Set(rows.map((r) => r.agentId));
};

/** Matches one Agent's pin in one Workspace; detach clears it by this too. */
export const agentPinWhere = (workspaceId: string, agentId: string) =>
  and(eq(pinTable.workspaceId, workspaceId), eq(pinTable.agentId, agentId));

export const pinAgent = async (
  ctx: ScopeContext,
  agentId: string,
): Promise<void> => {
  await requireScoped(db, "agent", agentId, ctx);
  // Already pinned is the common repeat; ON CONFLICT covers only the race.
  const [existing] = await db
    .select({ agentId: pinTable.agentId })
    .from(pinTable)
    .where(agentPinWhere(ctx.workspaceId, agentId))
    .limit(1);
  if (existing) return;
  await db
    .insert(pinTable)
    .values({ workspaceId: ctx.workspaceId, agentId })
    .onConflictDoNothing();
};

export const unpinAgent = async (
  ctx: ScopeContext,
  agentId: string,
): Promise<void> => {
  await requireScoped(db, "agent", agentId, ctx);
  await db.delete(pinTable).where(agentPinWhere(ctx.workspaceId, agentId));
};
