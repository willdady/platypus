import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
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
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import {
  createDashboard,
  createWidget,
  getDashboard,
  listDashboards,
  listWidgetRows,
  parseStoredWidgets,
  removeDashboard,
  removeWidget,
  updateDashboard,
  updateWidget,
} from "../services/dashboard.ts";
import { db } from "../index.ts";

const dashboard = new Hono<{ Variables: Variables }>();
const secured = [
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
] as const;

dashboard.get("/", ...secured, async (c) =>
  c.json({
    results: await listDashboards(db, workspaceScopeOf(c).workspaceId),
  }),
);
dashboard.post(
  "/",
  ...secured,
  sValidator("json", dashboardCreateSchema),
  async (c) => {
    const result = await createDashboard(
      db,
      workspaceScopeOf(c).workspaceId,
      c.req.valid("json"),
    );
    return c.json(result, 201);
  },
);
dashboard.get("/:dashboardId", ...secured, async (c) => {
  const { workspaceId } = workspaceScopeOf(c);
  return c.json(
    await getDashboard(db, c.req.param("dashboardId"), workspaceId),
  );
});
dashboard.put(
  "/:dashboardId",
  ...secured,
  sValidator("json", dashboardUpdateSchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    return c.json(
      await updateDashboard(
        db,
        c.req.param("dashboardId"),
        workspaceId,
        c.req.valid("json"),
      ),
    );
  },
);
dashboard.delete("/:dashboardId", ...secured, async (c) => {
  await removeDashboard(
    db,
    c.req.param("dashboardId"),
    workspaceScopeOf(c).workspaceId,
  );
  return c.body(null, 204);
});
dashboard.get("/:dashboardId/widgets", ...secured, async (c) => {
  const { workspaceId } = workspaceScopeOf(c);
  const dashboardId = c.req.param("dashboardId");
  return c.json({
    results: parseStoredWidgets(
      await listWidgetRows(db, dashboardId, workspaceId),
      dashboardId,
    ),
  });
});
dashboard.post(
  "/:dashboardId/widgets",
  ...secured,
  sValidator("json", widgetCreateSchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    return c.json(
      await createWidget(
        db,
        c.req.param("dashboardId"),
        workspaceId,
        c.req.valid("json"),
      ),
      201,
    );
  },
);
dashboard.put(
  "/:dashboardId/widgets/:widgetId",
  ...secured,
  sValidator("json", widgetUpdateDataSchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const body = c.req.valid("json");
    const result = await updateWidget(
      db,
      c.req.param("dashboardId"),
      c.req.param("widgetId"),
      workspaceId,
      body,
    );
    if (result && "typeMismatch" in result)
      throw new ValidationError("Widget type mismatch");
    if (!result) throw new NotFoundError("Widget not found");
    return c.json(result);
  },
);
dashboard.delete("/:dashboardId/widgets/:widgetId", ...secured, async (c) => {
  await removeWidget(
    db,
    c.req.param("dashboardId"),
    c.req.param("widgetId"),
    workspaceScopeOf(c).workspaceId,
  );
  return c.body(null, 204);
});

export { dashboard };
