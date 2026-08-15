import { and, eq, or, inArray, isNull } from "drizzle-orm";
import {
  agent as agentTable,
  skill as skillTable,
  mcp as mcpTable,
  provider as providerTable,
  attachment as attachmentTable,
} from "../db/schema.ts";
import { db } from "../index.ts";
import { ConflictError, LockedError, NotFoundError } from "../errors.ts";
import { isResourceListedInBlueprint } from "./blueprint-guard.ts";

/**
 * The read side of the **Scoped resource** (CONTEXT.md): an Agent, Skill, MCP,
 * or Provider whose row lives at exactly one scope — a Workspace or the
 * Organization, mutually exclusive (ADR-0007). Resolved relative to a
 * Workspace it yields a `(row, scope)` pair: Workspace-scoped rows are visible
 * directly; Organization-scoped (Shared) rows are visible only where an
 * **Attachment** exists, and are locked against Workspace-surface mutation.
 *
 * The Organization surface asks a narrower question — "is this a Shared
 * resource of this Organization?" — with no Workspace and so no Attachment in
 * play. `resolveOrgScoped`/`requireOrgScoped`/`listOrgScoped` answer it, and
 * take a bare `orgId` rather than a {@link ScopeContext} for exactly that
 * reason.
 *
 * Collapses the "resolve → null-check → org-scope-403" branch that the
 * dual-scope resource routes each re-implemented. `resolveScoped`/
 * `resolveScopedByName`/`listScoped`/`resolveOrgScoped`/`listOrgScoped` are
 * exception-free for callers that tolerate absence (e.g. the Chat-turn
 * attachment check, and the agent-facing Tools, which return an `{ error }`
 * payload rather than throwing); `requireScoped`/`requireOrgScoped`/
 * `requireWorkspaceMutable`/`requireSharedDeletable` throw the typed errors
 * mapped centrally by `app.onError` (ADR-0010).
 */

/** `"workspace"` for a directly-owned row, `"organization"` for a Shared one. */
export type Scope = "workspace" | "organization";

/** The dual-scope resource types — keyed by the `attachment.resourceType` enum. */
export type ScopedResourceType = "agent" | "skill" | "mcp" | "provider";

/** Maps each resource type to its Drizzle row type, for per-resource typing. */
export type RowOf = {
  agent: typeof agentTable.$inferSelect;
  skill: typeof skillTable.$inferSelect;
  mcp: typeof mcpTable.$inferSelect;
  provider: typeof providerTable.$inferSelect;
};

/**
 * The four dual-scope tables, each at its real type. They share the `id` /
 * `organizationId` / `workspaceId` columns this module relies on; the
 * per-resource row type is recovered via the `RowOf` cast at each return.
 */
type ScopedTable =
  | typeof agentTable
  | typeof skillTable
  | typeof mcpTable
  | typeof providerTable;

type RegistryEntry = {
  /** The Drizzle table backing this resource type. */
  table: ScopedTable;
  /** Human label used in the `NotFoundError` message ("Agent not found"). */
  label: string;
  /**
   * The resource as it reads mid-sentence in a conflict message ("this agent
   * is attached…"). Distinct from `label` because `mcp` stays the uppercase
   * acronym "MCP" rather than lowercasing to "mcp".
   */
  noun: string;
};

// Typed registry keyed by the `attachment.resourceType` enum.
const REGISTRY: Record<ScopedResourceType, RegistryEntry> = {
  agent: { table: agentTable, label: "Agent", noun: "agent" },
  skill: { table: skillTable, label: "Skill", noun: "skill" },
  mcp: { table: mcpTable, label: "MCP", noun: "MCP" },
  provider: { table: providerTable, label: "Provider", noun: "provider" },
};

/** The Workspace a Scoped resource is resolved relative to. */
export type ScopeContext = { orgId: string; wsId: string };

type Database = typeof db;

/**
 * Whether a row is a **Shared resource** of this Organization: org-scoped, and at
 * no Workspace. The two scope columns are mutually exclusive by a Zod refinement
 * on write, not by a database constraint, so "has this organizationId" is not on
 * its own enough — a row holding both belongs to its Workspace and must not reach
 * another one on the strength of the org column. Absent rows are not Shared, so a
 * dangling id fails this too.
 *
 * Exported because the Promotion guard (`findNonSharedReferences`) asks the same
 * question of rows it fetched itself.
 */
export const isSharedRow = (
  row:
    { organizationId: string | null; workspaceId: string | null } | undefined,
  orgId: string,
): boolean => !!row && row.organizationId === orgId && !row.workspaceId;

/** Whether this Workspace holds an Attachment for the given Shared resource. */
const isAttached = async (
  database: Database,
  type: ScopedResourceType,
  id: string,
  wsId: string,
): Promise<boolean> => {
  const [attached] = await database
    .select({ id: attachmentTable.id })
    .from(attachmentTable)
    .where(
      and(
        eq(attachmentTable.workspaceId, wsId),
        eq(attachmentTable.resourceType, type),
        eq(attachmentTable.resourceId, id),
      ),
    )
    .limit(1);
  return !!attached;
};

/**
 * Resolves a single resource visible inside this Workspace, or `null` when it
 * is not visible here. A Workspace-scoped row matches directly; an
 * Organization-scoped (Shared) row is visible only where an Attachment for this
 * Workspace exists. Never throws — absence is a normal outcome.
 */
export const resolveScoped = async <T extends ScopedResourceType>(
  database: Database,
  type: T,
  id: string,
  ctx: ScopeContext,
): Promise<{ row: RowOf[T]; scope: Scope } | null> => {
  const { table } = REGISTRY[type];

  const rows = await database
    .select()
    .from(table)
    .where(
      and(
        eq(table.id, id),
        or(
          eq(table.workspaceId, ctx.wsId),
          eq(table.organizationId, ctx.orgId),
        ),
      ),
    )
    .limit(1);
  const row = rows[0] as RowOf[T] | undefined;
  if (!row) return null;

  // Classified by which scope the row actually carries, not by elimination: a row
  // holding both columns would otherwise fall through to "workspace" and be
  // visible here on the strength of its organizationId alone.
  if (row.workspaceId === ctx.wsId) {
    return { row, scope: "workspace" };
  }
  if (!isSharedRow(row, ctx.orgId)) return null;

  // A Shared resource is visible here only through an Attachment (ADR-0007).
  if (!(await isAttached(database, type, id, ctx.wsId))) return null;
  return { row, scope: "organization" };
};

/**
 * {@link resolveScoped} keyed by name rather than id, for the agent-facing
 * Tools, which address resources the way a model does — by the name in the
 * prompt.
 *
 * Two queries rather than one, because a Workspace and its Organization may each
 * hold a resource of the same name: names are unique per scope, not across the
 * pair. The Workspace-scoped row wins outright, so the Workspace stays able to
 * define its own version of a Shared resource; a single `or(...)` + `LIMIT 1`
 * would pick between them in whatever order the planner happened to return.
 */
export const resolveScopedByName = async <T extends ScopedResourceType>(
  database: Database,
  type: T,
  name: string,
  ctx: ScopeContext,
): Promise<{ row: RowOf[T]; scope: Scope } | null> => {
  const { table } = REGISTRY[type];

  const workspaceRows = await database
    .select()
    .from(table)
    .where(and(eq(table.workspaceId, ctx.wsId), eq(table.name, name)))
    .limit(1);
  const workspaceRow = workspaceRows[0] as RowOf[T] | undefined;
  if (workspaceRow) return { row: workspaceRow, scope: "workspace" };

  // `isNull(workspaceId)` is what makes the row Shared: the scope columns are
  // mutually exclusive on write, not by a database constraint, so a row carrying
  // both must not reach another Workspace through that Workspace's Attachment.
  const orgRows = await database
    .select()
    .from(table)
    .where(
      and(
        eq(table.organizationId, ctx.orgId),
        isNull(table.workspaceId),
        eq(table.name, name),
      ),
    )
    .limit(1);
  const orgRow = orgRows[0] as RowOf[T] | undefined;
  if (!orgRow) return null;

  if (!(await isAttached(database, type, orgRow.id, ctx.wsId))) return null;
  return { row: orgRow, scope: "organization" };
};

/**
 * Lists the resources of this type visible in the Workspace: its Workspace-scoped
 * rows plus the Organization-scoped (Shared) rows attached to it. `ids` narrows
 * both to a known set of references — pass it through `listScopedByIds`, which
 * handles the empty case. Never throws.
 */
export const listScoped = async <T extends ScopedResourceType>(
  database: Database,
  type: T,
  ctx: ScopeContext,
  ids?: string[],
): Promise<{ row: RowOf[T]; scope: Scope }[]> => {
  const { table } = REGISTRY[type];

  const workspaceRows = await database
    .select()
    .from(table)
    .where(
      and(
        eq(table.workspaceId, ctx.wsId),
        ids ? inArray(table.id, ids) : undefined,
      ),
    );

  // Shared rows appear in a Workspace only where attached (ADR-0007) — gate by
  // an inner join on the Attachment table. `isNull(workspaceId)` is what makes
  // the row org-scoped: the scope columns are mutually exclusive on write, not by
  // a database constraint, so a row carrying both must not reach another
  // Workspace through that Workspace's Attachment.
  const attachedRows = await database
    .select()
    .from(table)
    .innerJoin(
      attachmentTable,
      and(
        eq(attachmentTable.resourceId, table.id),
        eq(attachmentTable.resourceType, type),
        eq(attachmentTable.workspaceId, ctx.wsId),
      ),
    )
    .where(
      and(
        eq(table.organizationId, ctx.orgId),
        isNull(table.workspaceId),
        ids ? inArray(table.id, ids) : undefined,
      ),
    );

  // The inner-join rows are keyed by the table's name, which matches the
  // resource type for every dual-scope table (`agent`, `skill`, `mcp`,
  // `provider`). The key is dynamic over the union table, so bridge through
  // `unknown` to recover the per-resource row shape.
  const orgRows = (attachedRows as unknown as Record<string, RowOf[T]>[]).map(
    (r) => r[type],
  );

  return [
    ...workspaceRows.map((row) => ({
      row: row as RowOf[T],
      scope: "workspace" as const,
    })),
    ...orgRows.map((row) => ({ row, scope: "organization" as const })),
  ];
};

/**
 * The subset of `ids` visible in this Workspace, each with its scope — the
 * single authority for "which of these references may this Workspace use?".
 * Ids that resolve to nothing are simply absent, so a caller can compare against
 * what it asked for (a save-time rejection) or carry on without them (a
 * run-time drop). Never throws; no query runs for an empty `ids`, which would
 * otherwise reach the database as `IN ()`.
 */
export const listScopedByIds = <T extends ScopedResourceType>(
  database: Database,
  type: T,
  ids: string[],
  ctx: ScopeContext,
): Promise<{ row: RowOf[T]; scope: Scope }[]> =>
  ids.length === 0 ? Promise.resolve([]) : listScoped(database, type, ctx, ids);

/**
 * Resolves a **Shared resource** of this Organization — the Organization
 * surface's counterpart to {@link resolveScoped}, where there is no Workspace
 * and so no Attachment to gate on. Returns `null` when the id is not a Shared
 * resource of this Organization. Never throws.
 *
 * `isNull(workspaceId)` carries the same defence `listScoped` applies to its
 * Organization half: the scope columns are mutually exclusive on write, not by a
 * database constraint, and a row carrying both belongs to its Workspace — it is
 * not Shared, and does not answer here. The org routes' own `UPDATE`/`DELETE`
 * clauses still match on `organizationId` alone; no route can write both columns,
 * so that gap is unreachable rather than closed.
 */
export const resolveOrgScoped = async <T extends ScopedResourceType>(
  database: Database,
  type: T,
  id: string,
  orgId: string,
): Promise<RowOf[T] | null> => {
  const { table } = REGISTRY[type];

  const rows = await database
    .select()
    .from(table)
    .where(
      and(
        eq(table.id, id),
        eq(table.organizationId, orgId),
        isNull(table.workspaceId),
      ),
    )
    .limit(1);
  return (rows[0] as RowOf[T] | undefined) ?? null;
};

/**
 * Like {@link resolveOrgScoped} but throws `NotFoundError` when the resource is
 * not a Shared resource of this Organization — for the org routes that treat
 * absence as a 404.
 */
export const requireOrgScoped = async <T extends ScopedResourceType>(
  database: Database,
  type: T,
  id: string,
  orgId: string,
): Promise<RowOf[T]> => {
  const row = await resolveOrgScoped(database, type, id, orgId);
  if (!row) {
    throw new NotFoundError(`${REGISTRY[type].label} not found`);
  }
  return row;
};

/**
 * Lists this Organization's Shared resources of a type — what the Organization
 * surface shows, and the set a Workspace may attach from. Never throws.
 */
export const listOrgScoped = async <T extends ScopedResourceType>(
  database: Database,
  type: T,
  orgId: string,
): Promise<RowOf[T][]> => {
  const { table } = REGISTRY[type];

  const rows = await database
    .select()
    .from(table)
    .where(and(eq(table.organizationId, orgId), isNull(table.workspaceId)));
  return rows as RowOf[T][];
};

/**
 * Like `resolveScoped` but throws `NotFoundError` when the resource is not
 * visible here — for routes that treat absence as a 404.
 */
export const requireScoped = async <T extends ScopedResourceType>(
  database: Database,
  type: T,
  id: string,
  ctx: ScopeContext,
): Promise<{ row: RowOf[T]; scope: Scope }> => {
  const found = await resolveScoped(database, type, id, ctx);
  if (!found) {
    throw new NotFoundError(`${REGISTRY[type].label} not found`);
  }
  return found;
};

/**
 * How a Workspace-surface mutation refuses a Shared row. Exported so the
 * agent-facing Tools — which return an `{ error }` payload rather than throwing
 * — refuse in the same words {@link requireWorkspaceMutable} does.
 */
export const workspaceMutationLockedMessage = (
  type: ScopedResourceType,
): string =>
  `This ${REGISTRY[type].label.toLowerCase()} is managed at the organization level`;

/**
 * Resolves a resource for Workspace-surface mutation: throws `NotFoundError`
 * when it is not visible here, then `LockedError` when it is an
 * Organization-scoped (Shared) row — a single source of truth edited only on
 * the Organization surface (ADR-0007). On success the row is guaranteed
 * Workspace-scoped.
 */
export const requireWorkspaceMutable = async <T extends ScopedResourceType>(
  database: Database,
  type: T,
  id: string,
  ctx: ScopeContext,
): Promise<{ row: RowOf[T]; scope: "workspace" }> => {
  const found = await requireScoped(database, type, id, ctx);
  if (found.scope === "organization") {
    throw new LockedError(workspaceMutationLockedMessage(type));
  }
  return { row: found.row, scope: "workspace" };
};

/**
 * Guards deletion of an Organization-scoped (Shared) resource: throws
 * `ConflictError` while anything still points at it — an Attachment in any
 * Workspace (ADR-0007) or a Blueprint that would re-provision it (ADR-0008).
 * The single home for the "can this Shared resource be deleted?" rule the four
 * org-resource delete routes each re-implemented inline; the `ConflictError` is
 * mapped to 409 at `app.onError` (ADR-0010). Returns when deletion may proceed.
 */
export const requireSharedDeletable = async (
  database: Database,
  type: ScopedResourceType,
  id: string,
): Promise<void> => {
  const [attached] = await database
    .select({ id: attachmentTable.id })
    .from(attachmentTable)
    .where(
      and(
        eq(attachmentTable.resourceType, type),
        eq(attachmentTable.resourceId, id),
      ),
    )
    .limit(1);
  if (attached) {
    throw new ConflictError(
      `Cannot delete: this ${REGISTRY[type].noun} is attached to one or more workspaces. Detach it first.`,
    );
  }

  if (await isResourceListedInBlueprint(type, id)) {
    throw new ConflictError(
      `Cannot delete: this ${REGISTRY[type].noun} is listed in one or more blueprints. Remove it from them first.`,
    );
  }
};
