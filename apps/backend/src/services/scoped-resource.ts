import { and, eq, or } from "drizzle-orm";
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
 * Collapses the "resolve → null-check → org-scope-403" branch that the
 * dual-scope resource routes each re-implemented. `resolveScoped`/`listScoped`
 * are exception-free for callers that tolerate absence (e.g. the Chat-turn
 * attachment check); `requireScoped`/`requireWorkspaceMutable`/
 * `requireSharedDeletable` throw the typed errors mapped centrally by
 * `app.onError` (ADR-0009).
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

  const isOrgScoped = !!row.organizationId && !row.workspaceId;
  if (!isOrgScoped) {
    return { row, scope: "workspace" };
  }

  // A Shared resource is visible here only through an Attachment (ADR-0007).
  const [attached] = await database
    .select({ id: attachmentTable.id })
    .from(attachmentTable)
    .where(
      and(
        eq(attachmentTable.workspaceId, ctx.wsId),
        eq(attachmentTable.resourceType, type),
        eq(attachmentTable.resourceId, id),
      ),
    )
    .limit(1);
  if (!attached) return null;
  return { row, scope: "organization" };
};

/**
 * Lists every resource of this type visible in the Workspace: its
 * Workspace-scoped rows plus the Organization-scoped (Shared) rows attached to
 * it. Never throws.
 */
export const listScoped = async <T extends ScopedResourceType>(
  database: Database,
  type: T,
  ctx: ScopeContext,
): Promise<{ row: RowOf[T]; scope: Scope }[]> => {
  const { table } = REGISTRY[type];

  const workspaceRows = await database
    .select()
    .from(table)
    .where(eq(table.workspaceId, ctx.wsId));

  // Shared rows appear in a Workspace only where attached (ADR-0007) — gate by
  // an inner join on the Attachment table.
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
    .where(eq(table.organizationId, ctx.orgId));

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
    throw new LockedError(
      `This ${REGISTRY[type].label.toLowerCase()} is managed at the organization level`,
    );
  }
  return { row: found.row, scope: "workspace" };
};

/**
 * Guards deletion of an Organization-scoped (Shared) resource: throws
 * `ConflictError` while anything still points at it — an Attachment in any
 * Workspace (ADR-0007) or a Blueprint that would re-provision it (ADR-0008).
 * The single home for the "can this Shared resource be deleted?" rule the four
 * org-resource delete routes each re-implemented inline; the `ConflictError` is
 * mapped to 409 at `app.onError` (ADR-0009). Returns when deletion may proceed.
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
