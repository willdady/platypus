import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  trigger as triggerTable,
  triggerRun as triggerRunTable,
} from "../db/schema.ts";
import { triggerCreateSchema, triggerUpdateSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import { resolveScoped } from "../services/scoped-resource.ts";
import {
  requireOwned,
  listOwned,
  deleteOwned,
} from "../services/workspace-resource.ts";
import { createTrigger, updateTrigger } from "../services/trigger.ts";
import { NotFoundError } from "../errors.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";

const trigger = new Hono<{ Variables: Variables }>();

/** List all triggers in workspace */
trigger.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const results = await listOwned(
      db,
      "trigger",
      workspaceId,
      desc(triggerTable.createdAt),
    );
    return c.json({ results });
  },
);

/** Get a trigger by ID */
trigger.get(
  "/:triggerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const triggerId = c.req.param("triggerId");
    const { workspaceId } = workspaceScopeOf(c);

    const record = await requireOwned(db, "trigger", triggerId, workspaceId);

    return c.json(record);
  },
);

/** Create a new trigger */
trigger.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", triggerCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const scope = workspaceScopeOf(c);
    const { workspaceId } = scope;

    // The Agent must be usable here: workspace-scoped, or a Shared one attached
    // to this Workspace (ADR-0007) — the same set the run resolves when the
    // trigger fires.
    const agentRecord = await resolveScoped(db, "agent", data.agentId, scope);

    if (!agentRecord) {
      return c.json({ error: "Agent not found in this workspace" }, 400);
    }

    const record = await createTrigger(scope, data);

    logger.info(
      `Created trigger '${record.id}' in workspace '${workspaceId}'${record.nextRunAt ? ` - next run at ${record.nextRunAt.toISOString()}` : ""}`,
    );

    return c.json(record, 201);
  },
);

/** Update a trigger */
trigger.put(
  "/:triggerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", triggerUpdateSchema),
  async (c) => {
    const triggerId = c.req.param("triggerId");
    const scope = workspaceScopeOf(c);
    const data = c.req.valid("json");

    // A new agentId must be usable here: workspace-scoped, or a Shared one
    // attached to this Workspace (ADR-0007) — see the create route.
    // `updateTrigger` itself 404s if the trigger doesn't exist.
    if (data.agentId) {
      const agentRecord = await resolveScoped(db, "agent", data.agentId, scope);

      if (!agentRecord) {
        return c.json({ error: "Agent not found in this workspace" }, 400);
      }
    }

    const record = await updateTrigger(scope, triggerId, data);

    logger.info(`Updated trigger '${triggerId}'`);

    return c.json(record, 200);
  },
);

/** Delete a trigger */
trigger.delete(
  "/:triggerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const triggerId = c.req.param("triggerId");
    const { workspaceId } = workspaceScopeOf(c);

    const deleted = await deleteOwned(db, "trigger", triggerId, workspaceId);

    if (!deleted) {
      throw new NotFoundError("Trigger not found");
    }

    logger.info(`Deleted trigger '${triggerId}'`);

    return c.json({ message: "Trigger deleted" });
  },
);

/** List runs for a trigger */
trigger.get(
  "/:triggerId/runs",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator(
    "query",
    z.object({
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  ),
  async (c) => {
    const triggerId = c.req.param("triggerId");
    const { workspaceId } = workspaceScopeOf(c);
    const { limit: limitStr, offset: offsetStr } = c.req.valid("query");

    const limit = Math.min(parseInt(limitStr ?? "100") || 100, 100);
    const offset = parseInt(offsetStr ?? "0") || 0;

    // Verify trigger exists in workspace
    await requireOwned(db, "trigger", triggerId, workspaceId);

    const results = await db
      .select()
      .from(triggerRunTable)
      .where(eq(triggerRunTable.triggerId, triggerId))
      .orderBy(desc(triggerRunTable.startedAt))
      .limit(limit)
      .offset(offset);

    return c.json({ results });
  },
);

export { trigger };
