import { and, eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  chat as chatTable,
  trigger as triggerTable,
  webhook as webhookTable,
  notification as notificationTable,
  sandbox as sandboxTable,
  a2aEndpoint as a2aEndpointTable,
} from "../db/schema.ts";
import type { db, Tx } from "../index.ts";
import { NotFoundError } from "../errors.ts";

type Database = typeof db | Tx;

export type WorkspaceResourceType =
  "chat" | "trigger" | "webhook" | "a2aEndpoint" | "notification" | "sandbox";

type WorkspaceTable =
  | typeof chatTable
  | typeof triggerTable
  | typeof webhookTable
  | typeof a2aEndpointTable
  | typeof notificationTable
  | typeof sandboxTable;

type RowOf = {
  chat: typeof chatTable.$inferSelect;
  trigger: typeof triggerTable.$inferSelect;
  webhook: typeof webhookTable.$inferSelect;
  a2aEndpoint: typeof a2aEndpointTable.$inferSelect;
  notification: typeof notificationTable.$inferSelect;
  sandbox: typeof sandboxTable.$inferSelect;
};

type WorkspaceScope = { workspaceId: string };

type ScopeOf = {
  chat: WorkspaceScope;
  trigger: WorkspaceScope;
  webhook: WorkspaceScope;
  a2aEndpoint: WorkspaceScope;
  notification: WorkspaceScope;
  sandbox: WorkspaceScope;
};

type OwnedRef<T extends WorkspaceResourceType> = ScopeOf[T] &
  (T extends "sandbox" ? { id?: undefined } : { id: string });

type ScopeParam = "workspaceId";

type RegistryEntry = {
  table: WorkspaceTable;
  label: string;
  notFoundMessage?: string;
  idless?: true;
  scope: { column: AnyPgColumn; param: ScopeParam };
};

const REGISTRY: Record<WorkspaceResourceType, RegistryEntry> = {
  chat: {
    table: chatTable,
    label: "Chat",
    scope: { column: chatTable.workspaceId, param: "workspaceId" },
  },
  trigger: {
    table: triggerTable,
    label: "Trigger",
    scope: { column: triggerTable.workspaceId, param: "workspaceId" },
  },
  webhook: {
    table: webhookTable,
    label: "Webhook",
    scope: { column: webhookTable.workspaceId, param: "workspaceId" },
  },
  a2aEndpoint: {
    table: a2aEndpointTable,
    label: "A2A endpoint",
    scope: { column: a2aEndpointTable.workspaceId, param: "workspaceId" },
  },
  notification: {
    table: notificationTable,
    label: "Notification",
    scope: { column: notificationTable.workspaceId, param: "workspaceId" },
  },
  sandbox: {
    table: sandboxTable,
    label: "Sandbox",
    notFoundMessage: "Sandbox not configured",
    idless: true,
    scope: { column: sandboxTable.workspaceId, param: "workspaceId" },
  },
};

const allOf = (...conditions: (SQL | undefined)[]): SQL => {
  const all = and(...conditions);
  if (!all) throw new Error("allOf composed no condition");
  return all;
};

const scopeWhere = (scope: RegistryEntry["scope"], scopeValue: string): SQL =>
  eq(scope.column, scopeValue);

export const ownedWhere = <T extends WorkspaceResourceType>(
  type: T,
  ref: OwnedRef<T>,
): SQL => {
  const { table, scope, idless } = REGISTRY[type];
  const { id } = ref as { id?: string };
  if (id === undefined && !idless) {
    throw new Error(`${type} lookup requires an id`);
  }
  return allOf(
    id !== undefined ? eq(table.id, id) : undefined,
    scopeWhere(scope, (ref as Record<ScopeParam, string>)[scope.param]),
  );
};

export const resolveOwned = async <T extends WorkspaceResourceType>(
  database: Database,
  type: T,
  ref: OwnedRef<T>,
): Promise<RowOf[T] | null> => {
  const { table } = REGISTRY[type];
  const rows = await database
    .select()
    .from(table)
    .where(ownedWhere(type, ref))
    .limit(1);
  return (rows[0] as RowOf[T] | undefined) ?? null;
};

export const requireOwned = async <T extends WorkspaceResourceType>(
  database: Database,
  type: T,
  ref: OwnedRef<T>,
): Promise<RowOf[T]> => {
  const row = await resolveOwned(database, type, ref);
  if (!row) {
    const { label, notFoundMessage } = REGISTRY[type];
    throw new NotFoundError(notFoundMessage ?? `${label} not found`);
  }
  return row;
};

export const listOwned = async <T extends WorkspaceResourceType>(
  database: Database,
  type: T,
  scope: ScopeOf[T],
  orderBy: SQL | null,
): Promise<RowOf[T][]> => {
  const { table, scope: scopeDescriptor } = REGISTRY[type];
  const query = database
    .select()
    .from(table)
    .where(
      scopeWhere(
        scopeDescriptor,
        (scope as Record<ScopeParam, string>)[scopeDescriptor.param],
      ),
    );
  const rows = orderBy === null ? await query : await query.orderBy(orderBy);
  return rows as RowOf[T][];
};

export const updateOwned = async <T extends WorkspaceResourceType>(
  database: Database,
  type: T,
  ref: OwnedRef<T>,
  values: Partial<RowOf[T]>,
): Promise<RowOf[T] | null> => {
  const { table } = REGISTRY[type];
  const rows = await database
    .update(table)
    .set(values)
    .where(ownedWhere(type, ref))
    .returning();
  return (rows[0] as RowOf[T] | undefined) ?? null;
};

export const deleteOwned = async <T extends WorkspaceResourceType>(
  database: Database,
  type: T,
  ref: OwnedRef<T>,
): Promise<boolean> => {
  const { table } = REGISTRY[type];
  const rows = await database
    .delete(table)
    .where(ownedWhere(type, ref))
    .returning();
  return rows.length > 0;
};
