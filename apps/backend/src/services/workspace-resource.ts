import { and, eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  chat as chatTable,
  dashboard as dashboardTable,
  widget as widgetTable,
  trigger as triggerTable,
  webhook as webhookTable,
  notification as notificationTable,
  sandbox as sandboxTable,
} from "../db/schema.ts";
import { db } from "../index.ts";
import { NotFoundError } from "../errors.ts";

/**
 * The **Workspace-child resource**: a Chat, Dashboard, Trigger, Webhook,
 * Webhook, Notification, Widget, or Sandbox whose row lives at exactly one
 * Workspace — no dual scope, no Attachment, unlike the Scoped resources in
 * `scoped-resource.ts`. Containment used to be hand-rolled at each of the 13
 * route files that own one of these tables, with the write side
 * (`UPDATE`/`DELETE`) frequently keyed on `eq(id)` alone once a preceding
 * `SELECT` had already checked the Workspace — two statements standing in for
 * one, so deleting the `SELECT` silently drops the containment check with no
 * compile error and no failing test.
 *
 * `resolveOwned`/`requireOwned`/`listOwned` answer the read side; `ownedWhere`
 * is the same predicate as a Drizzle condition, so `updateOwned`/`deleteOwned`
 * pass it straight to `.where(...)` and a write can never reach a row a read
 * would refuse. Modeled on `scoped-resource.ts`'s `requireScoped`/`resolveScoped`
 * pair; `resolveOwned`/`listOwned` stay exception-free, `requireOwned` throws
 * `NotFoundError` mapped centrally by `app.onError` (ADR-0010).
 *
 * Each registry entry carries a `scope: { column, param }` descriptor — the
 * equality that places a row in its scope — which lets the one generic family
 * cover the shapes that used to be bespoke quartets:
 *
 * - the flat resources are scoped by `workspaceId`;
 * - a Widget is nested one level down, carrying a `dashboardId` instead
 *   (mirroring `services/kanban.ts`'s `withinScope` for Card/Column under
 *   Board): the caller establishes the Dashboard is in this Workspace once
 *   (`requireOwned` with type `"dashboard"`), then every Widget lookup scopes
 *   to that id;
 * - the Sandbox is a one-per-Workspace singleton with no id to route on, so
 *   its ref carries the scope keys alone and every predicate is scope-only.
 */

type Database = typeof db;

/**
 * The flat Workspace-child resource types — one row per id, scoped by
 * `workspaceId` — plus Widget (scoped by `dashboardId`) and the Sandbox
 * singleton (addressed by `workspaceId` alone).
 */
export type WorkspaceResourceType =
  | "chat"
  | "dashboard"
  | "trigger"
  | "webhook"
  | "notification"
  | "widget"
  | "sandbox";

/**
 * The seven Workspace-child tables, each at its real type. They share the
 * `id` column and a scope column this module relies on; the per-resource row
 * type is recovered via the `RowOf` cast at each return.
 */
type WorkspaceTable =
  | typeof chatTable
  | typeof dashboardTable
  | typeof triggerTable
  | typeof webhookTable
  | typeof notificationTable
  | typeof widgetTable
  | typeof sandboxTable;

/** Maps each resource type to its Drizzle row type, for per-resource typing. */
type RowOf = {
  chat: typeof chatTable.$inferSelect;
  dashboard: typeof dashboardTable.$inferSelect;
  trigger: typeof triggerTable.$inferSelect;
  webhook: typeof webhookTable.$inferSelect;
  notification: typeof notificationTable.$inferSelect;
  widget: typeof widgetTable.$inferSelect;
  sandbox: typeof sandboxTable.$inferSelect;
};

/**
 * The scope keys a caller passes for each type — the value the registry's
 * scope column is matched against. A Widget's scope is its Dashboard's id;
 * everything else's is the Workspace's.
 */
type WorkspaceScope = { workspaceId: string };

type ScopeOf = {
  chat: WorkspaceScope;
  dashboard: WorkspaceScope;
  trigger: WorkspaceScope;
  webhook: WorkspaceScope;
  notification: WorkspaceScope;
  widget: { dashboardId: string };
  sandbox: WorkspaceScope;
};

/**
 * How a caller addresses a row of this type: its scope keys, plus `id` —
 * except the Sandbox singleton, which has no id to route on and is addressed
 * by its scope alone.
 */
type OwnedRef<T extends WorkspaceResourceType> = ScopeOf[T] &
  (T extends "sandbox" ? { id?: undefined } : { id: string });

type RegistryEntry = {
  /** The Drizzle table backing this resource type. */
  table: WorkspaceTable;
  /** Human label used in the `NotFoundError` message ("Chat not found"). */
  label: string;
  /**
   * Overrides the default `${label} not found` message `requireOwned` throws —
   * for the Sandbox, whose absence means "not configured" rather than "not
   * found".
   */
  notFoundMessage?: string;
  /**
   * True for a resource with no id of its own — a one-per-scope singleton
   * addressed by its scope alone, so its ref carries no `id` and every
   * predicate for it is scope-only.
   */
  idless?: true;
  /**
   * The containment equality placing a row in its scope: the column matched,
   * and the name (`param`) of the key the caller passes that value under, so
   * the predicates read it straight off the caller's ref object.
   */
  scope: { column: AnyPgColumn; param: "workspaceId" | "dashboardId" };
};

const REGISTRY: Record<WorkspaceResourceType, RegistryEntry> = {
  chat: {
    table: chatTable,
    label: "Chat",
    scope: { column: chatTable.workspaceId, param: "workspaceId" },
  },
  dashboard: {
    table: dashboardTable,
    label: "Dashboard",
    scope: { column: dashboardTable.workspaceId, param: "workspaceId" },
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
  notification: {
    table: notificationTable,
    label: "Notification",
    scope: { column: notificationTable.workspaceId, param: "workspaceId" },
  },
  widget: {
    table: widgetTable,
    label: "Widget",
    scope: { column: widgetTable.dashboardId, param: "dashboardId" },
  },
  sandbox: {
    table: sandboxTable,
    label: "Sandbox",
    notFoundMessage: "Sandbox not configured",
    idless: true,
    scope: { column: sandboxTable.workspaceId, param: "workspaceId" },
  },
};

/**
 * `and()` is typed to tolerate `undefined` operands and so widens to
 * `SQL | undefined`. Every condition composed below is concrete, and a
 * `.where(undefined)` would match the whole table — an unfiltered `UPDATE` or
 * `DELETE`. Asserting once here keeps that shape out of the predicates'
 * return types, so no caller can be handed it.
 */
const allOf = (...conditions: (SQL | undefined)[]): SQL => and(...conditions)!;

/**
 * The scope-half of every predicate here: this scope column equals this
 * value. The one place that equality is written for all seven tables.
 */
const scopeWhere = (scope: RegistryEntry["scope"], scopeValue: string): SQL =>
  eq(scope.column, scopeValue);

/**
 * The `WHERE` clause matching a single Workspace-child resource: this id, in
 * this scope (for the Sandbox singleton, just this scope — it has no id). The
 * one place that condition is written — every read or write in this module
 * composes it, so a write can never reach a row a read would refuse. A ref
 * missing the `id` an id-bearing type requires is a caller bug, and the
 * type-level guarantee is duplicated here: letting the id-half drop silently
 * would widen a keyed write (an `UPDATE`, a `DELETE`) into an unkeyed one
 * over the whole scope.
 */
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
    scopeWhere(scope, (ref as Record<string, string>)[scope.param]),
  );
};

/**
 * Resolves a single Workspace-child resource, or `null` when it does not
 * exist or is not in this scope. Never throws — absence is a normal outcome.
 */
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

/**
 * Like {@link resolveOwned} but throws `NotFoundError` when the resource does
 * not exist or is not in this scope — for routes that treat absence as a 404.
 */
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

/**
 * Lists every resource of this type in the scope, ordered by `orderBy`, or
 * unordered when passed `null`. `orderBy` is required (not optional) so a
 * caller always states its intent explicitly rather than the ordering
 * silently depending on whatever falsy value a condition happened to
 * evaluate to. Never throws.
 */
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
        (scope as Record<string, string>)[scopeDescriptor.param],
      ),
    );
  const rows = orderBy === null ? await query : await query.orderBy(orderBy);
  return rows as RowOf[T][];
};

/**
 * Updates a Workspace-child resource, scoped by {@link ownedWhere} rather than
 * `id` alone — the write side of the containment check {@link resolveOwned}
 * reads, so a caller cannot update a row it could not have resolved. Returns
 * the updated row, or `null` when nothing matched (not found, or not in this
 * scope).
 */
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

/**
 * Deletes a Workspace-child resource, scoped by {@link ownedWhere}. Returns
 * whether a row was actually deleted, so a route can 404 on a no-op delete
 * rather than assuming success.
 */
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
