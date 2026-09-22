import { and, asc, eq, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Widget } from "@platypus/schemas";
import {
  asWidget,
  widgetSchema,
  widgetUpdateDataSchema,
} from "@platypus/schemas";
import { db } from "../index.ts";
import {
  dashboard as dashboardTable,
  widget as widgetTable,
} from "../db/schema.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import {
  deleteOwned,
  listOwned,
  requireOwned,
  updateOwned,
} from "./workspace-resource.ts";
import { logger } from "../logger.ts";
import { formatIssues } from "../zod-issues.ts";

type DashboardRow = typeof dashboardTable.$inferSelect;
type WidgetRow = typeof widgetTable.$inferSelect;
type Database = typeof db;

export const parseStoredWidgets = (
  rows: WidgetRow[],
  dashboardId: string,
): Widget[] =>
  rows.flatMap((row) => {
    const parsed = widgetSchema.safeParse(row);
    if (parsed.success) return [asWidget(parsed.data)];
    logger.warn(
      {
        dashboardId,
        widgetId: row.id,
        widgetType: row.type,
        issues: formatIssues(parsed.error.issues),
      },
      "Widget omitted from dashboard: stored data does not match its type",
    );
    return [];
  });

export const listDashboards = (database: Database, workspaceId: string) =>
  listOwned(
    database,
    "dashboard",
    { workspaceId },
    asc(dashboardTable.createdAt),
  );

export const getDashboard = (
  database: Database,
  dashboardId: string,
  workspaceId: string,
) => requireOwned(database, "dashboard", { id: dashboardId, workspaceId });

const ensureDashboardNameAvailable = async (
  database: Database,
  workspaceId: string,
  name: string,
  exceptId?: string,
) => {
  const rows = await database
    .select({ id: dashboardTable.id })
    .from(dashboardTable)
    .where(
      and(
        eq(dashboardTable.workspaceId, workspaceId),
        eq(dashboardTable.name, name),
        exceptId ? ne(dashboardTable.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (rows.length)
    throw new ConflictError(
      "A dashboard with that name already exists in this workspace",
    );
};

export const createDashboard = async (
  database: Database,
  workspaceId: string,
  data: { name: string; description?: string | null },
) => {
  await ensureDashboardNameAvailable(database, workspaceId, data.name);
  const now = new Date();
  const rows = await database
    .insert(dashboardTable)
    .values({
      id: nanoid(),
      workspaceId,
      name: data.name,
      description: data.description ?? null,
      desktopLayout: [],
      mobileLayout: [],
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return rows[0];
};

export const updateDashboard = async (
  database: Database,
  dashboardId: string,
  workspaceId: string,
  data: Partial<
    Pick<
      DashboardRow,
      "name" | "description" | "desktopLayout" | "mobileLayout"
    >
  >,
) => {
  const existing = await getDashboard(database, dashboardId, workspaceId);
  if (data.name && data.name !== existing.name)
    await ensureDashboardNameAvailable(
      database,
      workspaceId,
      data.name,
      dashboardId,
    );
  return updateOwned(
    database,
    "dashboard",
    { id: dashboardId, workspaceId },
    {
      ...data,
      updatedAt: new Date(),
    },
  );
};

export const removeDashboard = async (
  database: Database,
  dashboardId: string,
  workspaceId: string,
) => {
  await getDashboard(database, dashboardId, workspaceId);
  await deleteOwned(database, "dashboard", { id: dashboardId, workspaceId });
};

export const listWidgets = async (
  database: Database,
  dashboardId: string,
  workspaceId: string,
) => {
  await getDashboard(database, dashboardId, workspaceId);
  return database
    .select({
      id: widgetTable.id,
      type: widgetTable.type,
      title: widgetTable.title,
    })
    .from(widgetTable)
    .where(eq(widgetTable.dashboardId, dashboardId))
    .orderBy(asc(widgetTable.createdAt));
};

export const listWidgetRows = async (
  database: Database,
  dashboardId: string,
  workspaceId: string,
) => {
  await getDashboard(database, dashboardId, workspaceId);
  return listOwned(
    database,
    "widget",
    { dashboardId },
    asc(widgetTable.createdAt),
  );
};

export const createWidget = async (
  database: Database,
  dashboardId: string,
  workspaceId: string,
  data: { type: WidgetRow["type"]; title: string },
) => {
  await getDashboard(database, dashboardId, workspaceId);
  const conflict = await database
    .select({ id: widgetTable.id })
    .from(widgetTable)
    .where(
      and(
        eq(widgetTable.dashboardId, dashboardId),
        eq(widgetTable.title, data.title),
      ),
    )
    .limit(1);
  if (conflict.length)
    throw new ConflictError(
      "A widget with that title already exists on this dashboard",
    );
  const now = new Date();
  const rows = await database
    .insert(widgetTable)
    .values({
      id: nanoid(),
      dashboardId,
      type: data.type,
      title: data.title,
      data: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return rows[0];
};

export const updateWidget = async (
  database: Database,
  dashboardId: string,
  widgetId: string,
  workspaceId: string,
  data: { type: WidgetRow["type"]; data: unknown; title?: string },
) => {
  await getDashboard(database, dashboardId, workspaceId);
  const existing = await requireOwned(database, "widget", {
    id: widgetId,
    dashboardId,
  });
  if (existing.type !== data.type) return { typeMismatch: true as const };
  // Matching `type` is only half the contract: `data` has to be the payload
  // that type declares. The REST route's body schema already pairs the two,
  // but the Agent tool set presents `type` and `data` as independent inputs
  // over an undiscriminated union, so a payload belonging to another Widget
  // type reaches here intact (#830). Pairing them once, here, covers both
  // surfaces and anything that calls this next.
  const pairing = widgetUpdateDataSchema.safeParse({
    type: data.type,
    data: data.data,
  });
  if (!pairing.success)
    throw new ValidationError(
      `Widget data does not match type "${data.type}": ${formatIssues(pairing.error.issues)}`,
    );
  if (data.title) {
    const conflict = await database
      .select({ id: widgetTable.id })
      .from(widgetTable)
      .where(
        and(
          eq(widgetTable.dashboardId, dashboardId),
          eq(widgetTable.title, data.title),
          ne(widgetTable.id, widgetId),
        ),
      )
      .limit(1);
    if (conflict.length)
      throw new ConflictError(
        "A widget with that title already exists on this dashboard",
      );
  }
  return updateOwned(
    database,
    "widget",
    { id: widgetId, dashboardId },
    {
      // The parse output, not the input: it is the payload as the named type's
      // own schema resolved it, rather than as whichever union branch happened
      // to match first.
      data: pairing.data.data,
      ...(data.title && { title: data.title }),
      updatedAt: new Date(),
    },
  );
};

export const getWidget = async (
  database: Database,
  dashboardId: string,
  widgetId: string,
  workspaceId: string,
) => {
  await getDashboard(database, dashboardId, workspaceId);
  const row = await requireOwned(database, "widget", {
    id: widgetId,
    dashboardId,
  });
  const parsed = parseStoredWidgets([row], dashboardId);
  if (!parsed.length) throw new NotFoundError("Widget not found");
  return parsed[0];
};

export const removeWidget = async (
  database: Database,
  dashboardId: string,
  widgetId: string,
  workspaceId: string,
) => {
  await getDashboard(database, dashboardId, workspaceId);
  await requireOwned(database, "widget", { id: widgetId, dashboardId });
  await deleteOwned(database, "widget", { id: widgetId, dashboardId });
};
