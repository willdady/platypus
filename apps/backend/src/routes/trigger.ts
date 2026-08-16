import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
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
  updateOwned,
  deleteOwned,
} from "../services/workspace-resource.ts";
import { NotFoundError } from "../errors.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";
import { validateCronExpression } from "../utils/cron.ts";

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

    let nextRunAt: Date | null = null;
    const config = data.config as Record<string, unknown>;

    if (data.type === "cron") {
      const cronExpression = config.cronExpression as string;
      const timezone = (config.timezone as string) || "UTC";
      nextRunAt = validateCronExpression(cronExpression, timezone);

      if (!nextRunAt) {
        return c.json({ error: "Invalid cron expression or timezone" }, 400);
      }
    } else if (data.type === "event") {
      const events = config.events as unknown[];
      if (!events || !Array.isArray(events) || events.length === 0) {
        return c.json(
          { message: "Event triggers must have at least one event" },
          400,
        );
      }
    }

    const id = nanoid();
    const now = new Date();

    const record = await db
      .insert(triggerTable)
      .values({
        id,
        ...data,
        workspaceId,
        nextRunAt,
        config: data.config,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    logger.info(
      `Created trigger '${id}' in workspace '${workspaceId}'${nextRunAt ? ` - next run at ${nextRunAt.toISOString()}` : ""}`,
    );

    return c.json(record[0], 201);
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
    const { workspaceId } = scope;
    const data = c.req.valid("json");

    // Verify trigger exists in workspace
    const existing = await requireOwned(db, "trigger", triggerId, workspaceId);

    // If agentId is being changed, verify new agent exists
    if (data.agentId && data.agentId !== existing.agentId) {
      // See the create route: workspace-scoped, or Shared and attached here.
      const agentRecord = await resolveScoped(db, "agent", data.agentId, scope);

      if (!agentRecord) {
        return c.json({ error: "Agent not found in this workspace" }, 400);
      }
    }

    const updateData: Record<string, unknown> = {
      ...data,
      updatedAt: new Date(),
    };

    // Determine the effective type (updated or existing)
    const effectiveType = data.type ?? existing.type;

    if (effectiveType === "event") {
      // Event triggers don't have nextRunAt
      if (data.config) {
        const config = data.config as Record<string, unknown>;
        const events = config.events as unknown[];
        if (!events || !Array.isArray(events) || events.length === 0) {
          return c.json(
            { error: "Event triggers must have at least one event" },
            400,
          );
        }
      }
      updateData.nextRunAt = null;
    } else if (effectiveType === "cron") {
      // Recompute nextRunAt if cron config changes
      const config = (data.config ?? existing.config) as Record<
        string,
        unknown
      >;
      const cronExpression = config.cronExpression as string;
      const timezone = (config.timezone as string) || "UTC";

      if (data.config || data.type) {
        const nextRunAt = validateCronExpression(cronExpression, timezone);
        if (!nextRunAt) {
          return c.json({ error: "Invalid cron expression or timezone" }, 400);
        }
        updateData.nextRunAt = nextRunAt;
      }
    }

    const record = await updateOwned(
      db,
      "trigger",
      triggerId,
      workspaceId,
      updateData,
    );

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
