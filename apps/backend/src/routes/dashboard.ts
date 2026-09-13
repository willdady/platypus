import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "../index.ts";
import {
  dashboard as dashboardTable,
  widget as widgetTable,
} from "../db/schema.ts";
import {
  dashboardCreateSchema,
  dashboardUpdateSchema,
  asWidget,
  widgetCreateSchema,
  widgetSchema,
  widgetUpdateDataSchema,
} from "@platypus/schemas";
import type { Widget } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import {
  requireOwned,
  listOwned,
  updateOwned,
  deleteOwned,
  requireOwnedWidget,
  listOwnedWidgets,
  updateOwnedWidget,
  deleteOwnedWidget,
} from "../services/workspace-resource.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";
import { formatIssues } from "../zod-issues.ts";

const dashboard = new Hono<{ Variables: Variables }>();

type WidgetRow = typeof widgetTable.$inferSelect;

/**
 * Validates stored Widgets against their own type's data contract, dropping
 * any row that fails.
 *
 * `widgetSchema` pairs each Widget type with its data schema — including the
 * Embed type's HTTPS-only URL — but nothing ran it on the read path, so the
 * pairing held for writes alone and the browser was the only thing checking a
 * persisted Embed URL (#798).
 *
 * A row can only fail here by having been written around the API, so it is
 * untrusted input rather than legacy data to repair: there is no backfill, and
 * one bad row must not take its Dashboard down with it.
 */
const parseStoredWidgets = (rows: WidgetRow[], dashboardId: string): Widget[] =>
  rows.flatMap((row) => {
    const parsed = widgetSchema.safeParse(row);
    if (parsed.success) {
      return [asWidget(parsed.data)];
    }
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

// --- Dashboard CRUD ---

dashboard.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const results = await listOwned(
      db,
      "dashboard",
      workspaceId,
      asc(dashboardTable.createdAt),
    );
    return c.json({ results });
  },
);

dashboard.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", dashboardCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const { workspaceId } = workspaceScopeOf(c);
    const conflict = await db
      .select({ id: dashboardTable.id })
      .from(dashboardTable)
      .where(
        and(
          eq(dashboardTable.workspaceId, workspaceId),
          eq(dashboardTable.name, data.name),
        ),
      )
      .limit(1);
    if (conflict.length) {
      return c.json(
        {
          error: "A dashboard with that name already exists in this workspace",
        },
        409,
      );
    }
    const now = new Date();
    const record = await db
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
    return c.json(record[0], 201);
  },
);

dashboard.get(
  "/:dashboardId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const dashboardId = c.req.param("dashboardId");
    const { workspaceId } = workspaceScopeOf(c);
    const record = await requireOwned(
      db,
      "dashboard",
      dashboardId,
      workspaceId,
    );
    return c.json(record);
  },
);

dashboard.put(
  "/:dashboardId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", dashboardUpdateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const dashboardId = c.req.param("dashboardId");
    const { workspaceId } = workspaceScopeOf(c);
    const existing = await requireOwned(
      db,
      "dashboard",
      dashboardId,
      workspaceId,
    );
    if (data.name && data.name !== existing.name) {
      const conflict = await db
        .select({ id: dashboardTable.id })
        .from(dashboardTable)
        .where(
          and(
            eq(dashboardTable.workspaceId, workspaceId),
            eq(dashboardTable.name, data.name),
          ),
        )
        .limit(1);
      if (conflict.length) {
        return c.json(
          {
            error:
              "A dashboard with that name already exists in this workspace",
          },
          409,
        );
      }
    }
    const updated = await updateOwned(
      db,
      "dashboard",
      dashboardId,
      workspaceId,
      {
        ...data,
        updatedAt: new Date(),
      },
    );
    return c.json(updated);
  },
);

dashboard.delete(
  "/:dashboardId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const dashboardId = c.req.param("dashboardId");
    const { workspaceId } = workspaceScopeOf(c);
    await requireOwned(db, "dashboard", dashboardId, workspaceId);
    await deleteOwned(db, "dashboard", dashboardId, workspaceId);
    return c.body(null, 204);
  },
);

// --- Widget CRUD ---

dashboard.get(
  "/:dashboardId/widgets",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const dashboardId = c.req.param("dashboardId");
    const { workspaceId } = workspaceScopeOf(c);
    await requireOwned(db, "dashboard", dashboardId, workspaceId);
    const rows = await listOwnedWidgets(
      db,
      dashboardId,
      asc(widgetTable.createdAt),
    );
    return c.json({ results: parseStoredWidgets(rows, dashboardId) });
  },
);

dashboard.post(
  "/:dashboardId/widgets",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", widgetCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const dashboardId = c.req.param("dashboardId");
    const { workspaceId } = workspaceScopeOf(c);
    await requireOwned(db, "dashboard", dashboardId, workspaceId);
    const conflict = await db
      .select({ id: widgetTable.id })
      .from(widgetTable)
      .where(
        and(
          eq(widgetTable.dashboardId, dashboardId),
          eq(widgetTable.title, data.title),
        ),
      )
      .limit(1);
    if (conflict.length) {
      return c.json(
        { error: "A widget with that title already exists on this dashboard" },
        409,
      );
    }
    const now = new Date();
    const record = await db
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
    return c.json(record[0], 201);
  },
);

dashboard.put(
  "/:dashboardId/widgets/:widgetId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", widgetUpdateDataSchema),
  async (c) => {
    const body = c.req.valid("json");
    const dashboardId = c.req.param("dashboardId");
    const widgetId = c.req.param("widgetId");
    const { workspaceId } = workspaceScopeOf(c);
    await requireOwned(db, "dashboard", dashboardId, workspaceId);
    const existing = await requireOwnedWidget(db, widgetId, dashboardId);
    if (existing.type !== body.type) {
      return c.json({ error: "Widget type mismatch" }, 400);
    }
    if (body.title) {
      const conflict = await db
        .select({ id: widgetTable.id })
        .from(widgetTable)
        .where(
          and(
            eq(widgetTable.dashboardId, dashboardId),
            eq(widgetTable.title, body.title),
            ne(widgetTable.id, widgetId),
          ),
        )
        .limit(1);
      if (conflict.length) {
        return c.json(
          {
            error: "A widget with that title already exists on this dashboard",
          },
          409,
        );
      }
    }
    const updated = await updateOwnedWidget(db, widgetId, dashboardId, {
      data: body.data,
      ...(body.title && { title: body.title }),
      updatedAt: new Date(),
    });
    return c.json(updated);
  },
);

dashboard.delete(
  "/:dashboardId/widgets/:widgetId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const dashboardId = c.req.param("dashboardId");
    const widgetId = c.req.param("widgetId");
    const { workspaceId } = workspaceScopeOf(c);
    await requireOwned(db, "dashboard", dashboardId, workspaceId);
    await requireOwnedWidget(db, widgetId, dashboardId);
    await deleteOwnedWidget(db, widgetId, dashboardId);
    return c.body(null, 204);
  },
);

export { dashboard };
