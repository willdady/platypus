import { and, eq, type SQL } from "drizzle-orm";
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
 * The **Workspace-child resource** (CONTEXT.md): a Chat, Dashboard, Trigger,
 * Webhook, or Notification whose row lives at exactly one Workspace — no dual
 * scope, no Attachment, unlike the Scoped resources in `scoped-resource.ts`.
 * Containment is a single `workspaceId` equality, but that equality was being
 * hand-rolled at each of the 13 route files that own one of these tables,
 * with the write side (`UPDATE`/`DELETE`) frequently keyed on `eq(id)` alone
 * once a preceding `SELECT` had already checked the Workspace — two statements
 * standing in for one, so deleting the `SELECT` silently drops the
 * containment check with no compile error and no failing test.
 *
 * `resolveOwned`/`requireOwned`/`listOwned` answer the read side; `ownedWhere`
 * is the same predicate as a Drizzle condition, so `updateOwned`/`deleteOwned`
 * pass it straight to `.where(...)` and a write can never reach a row a read
 * would refuse. Modeled on `scoped-resource.ts`'s `requireScoped`/`resolveScoped`
 * pair; `resolveOwned`/`listOwned` stay exception-free, `requireOwned` throws
 * `NotFoundError` mapped centrally by `app.onError` (ADR-0010).
 *
 * Widget is a Workspace-child resource too, but nested one level down — it
 * carries a `dashboardId`, not a `workspaceId`. It gets its own
 * `resolveOwnedWidget`/`requireOwnedWidget`/`listOwnedWidgets`/`updateOwnedWidget`/
 * `deleteOwnedWidget` scoped by the parent Dashboard's id, mirroring
 * `services/kanban.ts`'s `withinScope` for Card/Column under Board — the
 * caller establishes the Dashboard is in this Workspace once (`requireOwned`
 * with type `"dashboard"`), then every Widget lookup scopes to that id.
 *
 * Sandbox is a Workspace-child resource with no `id` of its own to route on —
 * it is a one-per-Workspace singleton addressed by `workspaceId` alone.
 * `resolveOwnedSandbox`/`requireOwnedSandbox` give it the same
 * resolve/require shape without a meaningless `id` parameter.
 */

type Database = typeof db;

/** The flat Workspace-child resource types — one row per id, scoped by `workspaceId`. */
export type WorkspaceResourceType =
  "chat" | "dashboard" | "trigger" | "webhook" | "notification";

type WorkspaceTable =
  | typeof chatTable
  | typeof dashboardTable
  | typeof triggerTable
  | typeof webhookTable
  | typeof notificationTable;

/** Maps each resource type to its Drizzle row type, for per-resource typing. */
type RowOf = {
  chat: typeof chatTable.$inferSelect;
  dashboard: typeof dashboardTable.$inferSelect;
  trigger: typeof triggerTable.$inferSelect;
  webhook: typeof webhookTable.$inferSelect;
  notification: typeof notificationTable.$inferSelect;
};

type RegistryEntry = {
  /** The Drizzle table backing this resource type. */
  table: WorkspaceTable;
  /** Human label used in the `NotFoundError` message ("Chat not found"). */
  label: string;
};

const REGISTRY: Record<WorkspaceResourceType, RegistryEntry> = {
  chat: { table: chatTable, label: "Chat" },
  dashboard: { table: dashboardTable, label: "Dashboard" },
  trigger: { table: triggerTable, label: "Trigger" },
  webhook: { table: webhookTable, label: "Webhook" },
  notification: { table: notificationTable, label: "Notification" },
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
 * The `WHERE` clause matching a single Workspace-child resource: this id, in
 * this Workspace. The one place that condition is written — every read or
 * write in this module composes it, so a write can never reach a row a read
 * would refuse.
 */
export const ownedWhere = (
  type: WorkspaceResourceType,
  id: string,
  workspaceId: string,
): SQL => {
  const { table } = REGISTRY[type];
  return allOf(eq(table.id, id), eq(table.workspaceId, workspaceId));
};

/**
 * Resolves a single Workspace-child resource, or `null` when it does not
 * exist or is not in this Workspace. Never throws — absence is a normal
 * outcome.
 */
export const resolveOwned = async <T extends WorkspaceResourceType>(
  database: Database,
  type: T,
  id: string,
  workspaceId: string,
): Promise<RowOf[T] | null> => {
  const { table } = REGISTRY[type];
  const rows = await database
    .select()
    .from(table)
    .where(ownedWhere(type, id, workspaceId))
    .limit(1);
  return (rows[0] as RowOf[T] | undefined) ?? null;
};

/**
 * Like {@link resolveOwned} but throws `NotFoundError` when the resource does
 * not exist or is not in this Workspace — for routes that treat absence as a
 * 404.
 */
export const requireOwned = async <T extends WorkspaceResourceType>(
  database: Database,
  type: T,
  id: string,
  workspaceId: string,
): Promise<RowOf[T]> => {
  const row = await resolveOwned(database, type, id, workspaceId);
  if (!row) {
    throw new NotFoundError(`${REGISTRY[type].label} not found`);
  }
  return row;
};

/**
 * Lists every resource of this type in the Workspace, ordered by `orderBy`, or
 * unordered when passed `null`. `orderBy` is required (not optional) so a
 * caller always states its intent explicitly rather than the ordering
 * silently depending on whatever falsy value a condition happened to
 * evaluate to. Never throws.
 */
export const listOwned = async <T extends WorkspaceResourceType>(
  database: Database,
  type: T,
  workspaceId: string,
  orderBy: SQL | null,
): Promise<RowOf[T][]> => {
  const { table } = REGISTRY[type];
  const query = database
    .select()
    .from(table)
    .where(eq(table.workspaceId, workspaceId));
  const rows = orderBy === null ? await query : await query.orderBy(orderBy);
  return rows as RowOf[T][];
};

/**
 * Updates a Workspace-child resource, scoped by {@link ownedWhere} rather than
 * `id` alone — the write side of the containment check {@link resolveOwned}
 * reads, so a caller cannot update a row it could not have resolved. Returns
 * the updated row, or `null` when nothing matched (not found, or not in this
 * Workspace).
 */
export const updateOwned = async <T extends WorkspaceResourceType>(
  database: Database,
  type: T,
  id: string,
  workspaceId: string,
  values: Partial<RowOf[T]>,
): Promise<RowOf[T] | null> => {
  const { table } = REGISTRY[type];
  const rows = await database
    .update(table)
    .set(values)
    .where(ownedWhere(type, id, workspaceId))
    .returning();
  return (rows[0] as RowOf[T] | undefined) ?? null;
};

/**
 * Deletes a Workspace-child resource, scoped by {@link ownedWhere}. Returns
 * whether a row was actually deleted, so a route can 404 on a no-op delete
 * rather than assuming success.
 */
export const deleteOwned = async (
  database: Database,
  type: WorkspaceResourceType,
  id: string,
  workspaceId: string,
): Promise<boolean> => {
  const { table } = REGISTRY[type];
  const rows = await database
    .delete(table)
    .where(ownedWhere(type, id, workspaceId))
    .returning();
  return rows.length > 0;
};

// --- Widget: nested under Dashboard, scoped by dashboardId ---

type WidgetRow = typeof widgetTable.$inferSelect;

/**
 * The `WHERE` clause matching a single Widget within a given Dashboard. The
 * caller is responsible for having already established that the Dashboard
 * itself is in this Workspace (via `requireOwned(db, "dashboard", ...)`) —
 * this predicate only narrows within that already-validated Dashboard.
 */
export const widgetOwnedWhere = (id: string, dashboardId: string): SQL =>
  allOf(eq(widgetTable.id, id), eq(widgetTable.dashboardId, dashboardId));

/** Resolves a single Widget on this Dashboard, or `null`. Never throws. */
export const resolveOwnedWidget = async (
  database: Database,
  id: string,
  dashboardId: string,
): Promise<WidgetRow | null> => {
  const rows = await database
    .select()
    .from(widgetTable)
    .where(widgetOwnedWhere(id, dashboardId))
    .limit(1);
  return rows[0] ?? null;
};

/** Like {@link resolveOwnedWidget} but throws `NotFoundError` when absent. */
export const requireOwnedWidget = async (
  database: Database,
  id: string,
  dashboardId: string,
): Promise<WidgetRow> => {
  const row = await resolveOwnedWidget(database, id, dashboardId);
  if (!row) {
    throw new NotFoundError("Widget not found");
  }
  return row;
};

/**
 * Lists every Widget on this Dashboard, ordered by `orderBy`, or unordered
 * when passed `null`. Never throws.
 */
export const listOwnedWidgets = async (
  database: Database,
  dashboardId: string,
  orderBy: SQL | null,
): Promise<WidgetRow[]> => {
  const query = database
    .select()
    .from(widgetTable)
    .where(eq(widgetTable.dashboardId, dashboardId));
  return orderBy === null ? query : query.orderBy(orderBy);
};

/** Updates a Widget, scoped by {@link widgetOwnedWhere}. */
export const updateOwnedWidget = async (
  database: Database,
  id: string,
  dashboardId: string,
  values: Partial<WidgetRow>,
): Promise<WidgetRow | null> => {
  const rows = await database
    .update(widgetTable)
    .set(values)
    .where(widgetOwnedWhere(id, dashboardId))
    .returning();
  return rows[0] ?? null;
};

/** Deletes a Widget, scoped by {@link widgetOwnedWhere}. */
export const deleteOwnedWidget = async (
  database: Database,
  id: string,
  dashboardId: string,
): Promise<boolean> => {
  const rows = await database
    .delete(widgetTable)
    .where(widgetOwnedWhere(id, dashboardId))
    .returning();
  return rows.length > 0;
};

// --- Sandbox: a one-per-Workspace singleton, no id of its own ---

type SandboxRow = typeof sandboxTable.$inferSelect;

/** Resolves this Workspace's sandbox, or `null` when none is configured. */
export const resolveOwnedSandbox = async (
  database: Database,
  workspaceId: string,
): Promise<SandboxRow | null> => {
  const rows = await database
    .select()
    .from(sandboxTable)
    .where(eq(sandboxTable.workspaceId, workspaceId))
    .limit(1);
  return rows[0] ?? null;
};

/**
 * Like {@link resolveOwnedSandbox} but throws `NotFoundError` when none is
 * configured — for routes that treat absence as a 404.
 */
export const requireOwnedSandbox = async (
  database: Database,
  workspaceId: string,
): Promise<SandboxRow> => {
  const row = await resolveOwnedSandbox(database, workspaceId);
  if (!row) {
    throw new NotFoundError("Sandbox not configured");
  }
  return row;
};

/**
 * Updates this Workspace's sandbox, scoped by `workspaceId` — the write side
 * of the containment check {@link resolveOwnedSandbox} reads. Returns the
 * updated row, or `null` when none is configured.
 */
export const updateOwnedSandbox = async (
  database: Database,
  workspaceId: string,
  values: Partial<SandboxRow>,
): Promise<SandboxRow | null> => {
  const rows = await database
    .update(sandboxTable)
    .set(values)
    .where(eq(sandboxTable.workspaceId, workspaceId))
    .returning();
  return rows[0] ?? null;
};

/** Deletes this Workspace's sandbox. Returns whether a row was deleted. */
export const deleteOwnedSandbox = async (
  database: Database,
  workspaceId: string,
): Promise<boolean> => {
  const rows = await database
    .delete(sandboxTable)
    .where(eq(sandboxTable.workspaceId, workspaceId))
    .returning();
  return rows.length > 0;
};
