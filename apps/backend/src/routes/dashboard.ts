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
  widgetCreateSchema,
  widgetUpdateDataSchema,
} from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

const dashboard = new Hono<{ Variables: Variables }>();

// --- Dashboard CRUD ---

dashboard.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const results = await db
      .select()
      .from(dashboardTable)
      .where(eq(dashboardTable.workspaceId, workspaceId))
      .orderBy(asc(dashboardTable.createdAt));
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
    const workspaceId = c.req.param("workspaceId")!;
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
    const workspaceId = c.req.param("workspaceId")!;
    const record = await db
      .select()
      .from(dashboardTable)
      .where(eq(dashboardTable.id, dashboardId))
      .limit(1);
    if (!record.length || record[0].workspaceId !== workspaceId) {
      return c.json({ error: "Dashboard not found" }, 404);
    }
    return c.json(record[0]);
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
    const workspaceId = c.req.param("workspaceId")!;
    const existing = await db
      .select({
        id: dashboardTable.id,
        workspaceId: dashboardTable.workspaceId,
        name: dashboardTable.name,
      })
      .from(dashboardTable)
      .where(eq(dashboardTable.id, dashboardId))
      .limit(1);
    if (!existing.length || existing[0].workspaceId !== workspaceId) {
      return c.json({ error: "Dashboard not found" }, 404);
    }
    if (data.name && data.name !== existing[0].name) {
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
    const updated = await db
      .update(dashboardTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(dashboardTable.id, dashboardId))
      .returning();
    return c.json(updated[0]);
  },
);

dashboard.delete(
  "/:dashboardId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const dashboardId = c.req.param("dashboardId");
    const workspaceId = c.req.param("workspaceId")!;
    const existing = await db
      .select({
        id: dashboardTable.id,
        workspaceId: dashboardTable.workspaceId,
      })
      .from(dashboardTable)
      .where(eq(dashboardTable.id, dashboardId))
      .limit(1);
    if (!existing.length || existing[0].workspaceId !== workspaceId) {
      return c.json({ error: "Dashboard not found" }, 404);
    }
    await db.delete(dashboardTable).where(eq(dashboardTable.id, dashboardId));
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
    const workspaceId = c.req.param("workspaceId")!;
    const dash = await db
      .select({
        id: dashboardTable.id,
        workspaceId: dashboardTable.workspaceId,
      })
      .from(dashboardTable)
      .where(eq(dashboardTable.id, dashboardId))
      .limit(1);
    if (!dash.length || dash[0].workspaceId !== workspaceId) {
      return c.json({ error: "Dashboard not found" }, 404);
    }
    const results = await db
      .select()
      .from(widgetTable)
      .where(eq(widgetTable.dashboardId, dashboardId))
      .orderBy(asc(widgetTable.createdAt));
    return c.json({ results });
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
    const workspaceId = c.req.param("workspaceId")!;
    const dash = await db
      .select({
        id: dashboardTable.id,
        workspaceId: dashboardTable.workspaceId,
      })
      .from(dashboardTable)
      .where(eq(dashboardTable.id, dashboardId))
      .limit(1);
    if (!dash.length || dash[0].workspaceId !== workspaceId) {
      return c.json({ error: "Dashboard not found" }, 404);
    }
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
    const workspaceId = c.req.param("workspaceId")!;
    const dash = await db
      .select({
        id: dashboardTable.id,
        workspaceId: dashboardTable.workspaceId,
      })
      .from(dashboardTable)
      .where(eq(dashboardTable.id, dashboardId))
      .limit(1);
    if (!dash.length || dash[0].workspaceId !== workspaceId) {
      return c.json({ error: "Dashboard not found" }, 404);
    }
    const existing = await db
      .select({
        id: widgetTable.id,
        dashboardId: widgetTable.dashboardId,
        type: widgetTable.type,
      })
      .from(widgetTable)
      .where(eq(widgetTable.id, widgetId))
      .limit(1);
    if (!existing.length || existing[0].dashboardId !== dashboardId) {
      return c.json({ error: "Widget not found" }, 404);
    }
    if (existing[0].type !== body.type) {
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
    const updated = await db
      .update(widgetTable)
      .set({
        data: body.data,
        ...(body.title && { title: body.title }),
        updatedAt: new Date(),
      })
      .where(eq(widgetTable.id, widgetId))
      .returning();
    return c.json(updated[0]);
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
    const workspaceId = c.req.param("workspaceId")!;
    const dash = await db
      .select({
        id: dashboardTable.id,
        workspaceId: dashboardTable.workspaceId,
      })
      .from(dashboardTable)
      .where(eq(dashboardTable.id, dashboardId))
      .limit(1);
    if (!dash.length || dash[0].workspaceId !== workspaceId) {
      return c.json({ error: "Dashboard not found" }, 404);
    }
    const existing = await db
      .select({ id: widgetTable.id, dashboardId: widgetTable.dashboardId })
      .from(widgetTable)
      .where(eq(widgetTable.id, widgetId))
      .limit(1);
    if (!existing.length || existing[0].dashboardId !== dashboardId) {
      return c.json({ error: "Widget not found" }, 404);
    }
    await db.delete(widgetTable).where(eq(widgetTable.id, widgetId));
    return c.body(null, 204);
  },
);

export { dashboard };
