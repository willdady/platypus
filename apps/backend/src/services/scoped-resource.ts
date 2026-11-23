import { and, eq, or, inArray, isNull, type SQL } from "drizzle-orm";
import {
  agent as agentTable,
  skill as skillTable,
  mcp as mcpTable,
  provider as providerTable,
  attachment as attachmentTable,
} from "../db/schema.ts";
import type { Executor } from "../index.ts";
import type { ScopeContext } from "../scope.ts";
import { ConflictError, LockedError, NotFoundError } from "../errors.ts";
import { isResourceListedInBlueprint } from "./blueprint-guard.ts";

export type Scope = "workspace" | "organization";

export type ScopedResourceType = "agent" | "skill" | "mcp" | "provider";

export type RowOf = {
  agent: typeof agentTable.$inferSelect;
  skill: typeof skillTable.$inferSelect;
  mcp: typeof mcpTable.$inferSelect;
  provider: typeof providerTable.$inferSelect;
};

type ScopedTable =
  | typeof agentTable
  | typeof skillTable
  | typeof mcpTable
  | typeof providerTable;

type RegistryEntry = {
  table: ScopedTable;
  label: string;
  noun: string;
};

const REGISTRY: Record<ScopedResourceType, RegistryEntry> = {
  agent: { table: agentTable, label: "Agent", noun: "agent" },
  skill: { table: skillTable, label: "Skill", noun: "skill" },
  mcp: { table: mcpTable, label: "MCP", noun: "MCP" },
  provider: { table: providerTable, label: "Provider", noun: "provider" },
};

const SCOPED_RESOURCE_TYPES = new Set<string>(Object.keys(REGISTRY));

export const isScopedResourceType = (
  value: string | undefined,
): value is ScopedResourceType =>
  value !== undefined && SCOPED_RESOURCE_TYPES.has(value);

export const tableOf = (type: ScopedResourceType): ScopedTable =>
  REGISTRY[type].table;

export const labelOf = (type: ScopedResourceType): string =>
  REGISTRY[type].label;

export const nounOf = (type: ScopedResourceType): string => REGISTRY[type].noun;

export type Database = Executor;

const allOf = (...conditions: (SQL | undefined)[]): SQL => {
  const all = and(...conditions);
  if (!all) throw new Error("allOf composed no condition");
  return all;
};

const sharedWhere = (table: ScopedTable, orgId: string): SQL =>
  allOf(eq(table.organizationId, orgId), isNull(table.workspaceId));

export const orgScopedWhere = (
  type: ScopedResourceType,
  id: string,
  orgId: string,
): SQL => {
  const { table } = REGISTRY[type];
  return allOf(eq(table.id, id), sharedWhere(table, orgId));
};

export const workspaceScopedWhere = (
  type: ScopedResourceType,
  id: string,
  workspaceId: string,
): SQL => {
  const { table } = REGISTRY[type];
  return allOf(eq(table.id, id), eq(table.workspaceId, workspaceId));
};

export const orgScopedWhereIn = (
  type: ScopedResourceType,
  ids: string[],
  orgId: string,
): SQL => {
  const { table } = REGISTRY[type];
  return allOf(inArray(table.id, ids), sharedWhere(table, orgId));
};

export const isSharedRow = (
  row: { organizationId: string | null } | undefined,
  orgId: string,
): boolean => !!row && row.organizationId === orgId;

const isAttached = async (
  database: Database,
  type: ScopedResourceType,
  id: string,
  workspaceId: string,
): Promise<boolean> => {
  const [attached] = await database
    .select({ id: attachmentTable.id })
    .from(attachmentTable)
    .where(
      and(
        eq(attachmentTable.workspaceId, workspaceId),
        eq(attachmentTable.resourceType, type),
        eq(attachmentTable.resourceId, id),
      ),
    )
    .limit(1);
  return !!attached;
};

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
          eq(table.workspaceId, ctx.workspaceId),
          eq(table.organizationId, ctx.orgId),
        ),
      ),
    )
    .limit(1);
  const row = rows[0] as RowOf[T] | undefined;
  if (!row) return null;

  if (row.workspaceId === ctx.workspaceId) {
    return { row, scope: "workspace" };
  }
  if (!isSharedRow(row, ctx.orgId)) return null;

  if (!(await isAttached(database, type, id, ctx.workspaceId))) return null;
  return { row, scope: "organization" };
};

export const resolveScopedByName = async <T extends ScopedResourceType>(
  database: Database,
  type: T,
  name: string,
  ctx: ScopeContext,
  allowedIds?: string[],
): Promise<{ row: RowOf[T]; scope: Scope } | null> => {
  const { table } = REGISTRY[type];

  const idFilter = allowedIds ? inArray(table.id, allowedIds) : undefined;
  const workspaceRows = await database
    .select()
    .from(table)
    .where(
      and(
        eq(table.workspaceId, ctx.workspaceId),
        eq(table.name, name),
        idFilter,
      ),
    )
    .limit(1);
  const workspaceRow = workspaceRows[0] as RowOf[T] | undefined;
  if (workspaceRow) return { row: workspaceRow, scope: "workspace" };

  const orgRows = await database
    .select()
    .from(table)
    .where(and(sharedWhere(table, ctx.orgId), eq(table.name, name), idFilter))
    .limit(1);
  const orgRow = orgRows[0] as RowOf[T] | undefined;
  if (!orgRow) return null;

  if (!(await isAttached(database, type, orgRow.id, ctx.workspaceId)))
    return null;
  return { row: orgRow, scope: "organization" };
};

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
        eq(table.workspaceId, ctx.workspaceId),
        ids ? inArray(table.id, ids) : undefined,
      ),
    );

  const attachedRows = await database
    .select()
    .from(table)
    .innerJoin(
      attachmentTable,
      and(
        eq(attachmentTable.resourceId, table.id),
        eq(attachmentTable.resourceType, type),
        eq(attachmentTable.workspaceId, ctx.workspaceId),
      ),
    )
    .where(
      and(
        sharedWhere(table, ctx.orgId),
        ids ? inArray(table.id, ids) : undefined,
      ),
    );

  const orgRows = (attachedRows as unknown as Record<T, RowOf[T]>[]).map(
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

export const listScopedByIds = <T extends ScopedResourceType>(
  database: Database,
  type: T,
  ids: string[],
  ctx: ScopeContext,
): Promise<{ row: RowOf[T]; scope: Scope }[]> =>
  ids.length === 0 ? Promise.resolve([]) : listScoped(database, type, ctx, ids);

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
    .where(orgScopedWhere(type, id, orgId))
    .limit(1);
  return (rows[0] as RowOf[T] | undefined) ?? null;
};

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

export const listOrgScoped = async <T extends ScopedResourceType>(
  database: Database,
  type: T,
  orgId: string,
): Promise<RowOf[T][]> => {
  const { table } = REGISTRY[type];

  const rows = await database
    .select()
    .from(table)
    .where(sharedWhere(table, orgId));
  return rows as RowOf[T][];
};

export const listOrgScopedIds = async (
  database: Database,
  type: ScopedResourceType,
  ids: string[],
  orgId: string,
): Promise<Set<string>> => {
  if (ids.length === 0) return new Set();
  const { table } = REGISTRY[type];

  const rows = await database
    .select({ id: table.id })
    .from(table)
    .where(orgScopedWhereIn(type, ids, orgId));
  return new Set(rows.map((r) => r.id));
};

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

export const workspaceMutationLockedMessage = (
  type: ScopedResourceType,
): string =>
  `This ${REGISTRY[type].label.toLowerCase()} is managed at the organization level`;

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

  if (await isResourceListedInBlueprint(type, id, database)) {
    throw new ConflictError(
      `Cannot delete: this ${REGISTRY[type].noun} is listed in one or more blueprints. Remove it from them first.`,
    );
  }
};

export const inUseConflict = (
  type: ScopedResourceType,
  dependent: string,
  names: string[],
): ConflictError => {
  const one = names.length === 1;
  const them = one ? "it" : "them";
  const quoted = names.map((name) => `"${name}"`).join(", ");
  const { noun } = REGISTRY[type];
  return new ConflictError(
    `Cannot delete: this ${noun} is used by ${names.length} ${dependent}${
      one ? "" : "s"
    } (${quoted}). Delete ${them} or switch ${them} to another ${noun} first.`,
  );
};
