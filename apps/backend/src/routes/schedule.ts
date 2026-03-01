import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  schedule as scheduleTable,
  scheduleRun as scheduleRunTable,
  chat as chatTable,
  agent as agentTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { scheduleCreateSchema, scheduleUpdateSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceOwner,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";
import { validateCronExpression } from "../utils/cron.ts";

const schedule = new Hono<{ Variables: Variables }>();

/** List all schedules in workspace */
schedule.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const results = await db
      .select()
      .from(scheduleTable)
      .where(eq(scheduleTable.workspaceId, workspaceId))
      .orderBy(desc(scheduleTable.createdAt));
    return c.json({ results });
  },
);

/** Get a schedule by ID */
schedule.get(
  "/:scheduleId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const scheduleId = c.req.param("scheduleId");
    const workspaceId = c.req.param("workspaceId")!;

    const record = await db
      .select()
      .from(scheduleTable)
      .where(
        and(
          eq(scheduleTable.id, scheduleId),
          eq(scheduleTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (record.length === 0) {
      return c.json({ message: "Schedule not found" }, 404);
    }

    return c.json(record[0]);
  },
);

/** Create a new schedule */
schedule.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", scheduleCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const workspaceId = c.req.param("workspaceId")!;

    // Verify agent exists in workspace
    const agentRecord = await db
      .select()
      .from(agentTable)
      .where(
        and(
          eq(agentTable.id, data.agentId),
          eq(agentTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (agentRecord.length === 0) {
      return c.json({ message: "Agent not found in this workspace" }, 400);
    }

    // Validate cron expression
    const nextRunAt = validateCronExpression(
      data.cronExpression,
      data.timezone || "UTC",
    );

    if (!nextRunAt) {
      return c.json({ message: "Invalid cron expression or timezone" }, 400);
    }

    const id = nanoid();
    const now = new Date();

    const record = await db
      .insert(scheduleTable)
      .values({
        id,
        ...data,
        workspaceId,
        nextRunAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    logger.info(
      `Created schedule '${id}' in workspace '${workspaceId}' - next run at ${nextRunAt.toISOString()}`,
    );

    return c.json(record[0], 201);
  },
);

/** Update a schedule */
schedule.put(
  "/:scheduleId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", scheduleUpdateSchema),
  async (c) => {
    const scheduleId = c.req.param("scheduleId");
    const workspaceId = c.req.param("workspaceId")!;
    const data = c.req.valid("json");

    // Verify schedule exists in workspace
    const existing = await db
      .select()
      .from(scheduleTable)
      .where(
        and(
          eq(scheduleTable.id, scheduleId),
          eq(scheduleTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      return c.json({ message: "Schedule not found" }, 404);
    }

    // If agentId is being changed, verify new agent exists
    if (data.agentId && data.agentId !== existing[0].agentId) {
      const agentRecord = await db
        .select()
        .from(agentTable)
        .where(
          and(
            eq(agentTable.id, data.agentId),
            eq(agentTable.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (agentRecord.length === 0) {
        return c.json({ message: "Agent not found in this workspace" }, 400);
      }
    }

    // Recompute nextRunAt if cron expression or timezone changed
    let nextRunAt: Date | null = null;
    const cronExpression = data.cronExpression ?? existing[0].cronExpression;
    const timezone = data.timezone ?? existing[0].timezone;

    if (data.cronExpression || data.timezone) {
      nextRunAt = validateCronExpression(cronExpression, timezone);
      if (!nextRunAt) {
        return c.json({ message: "Invalid cron expression or timezone" }, 400);
      }
    }

    const updateData: Record<string, unknown> = {
      ...data,
      updatedAt: new Date(),
    };

    if (nextRunAt) {
      updateData.nextRunAt = nextRunAt;
    }

    const record = await db
      .update(scheduleTable)
      .set(updateData)
      .where(eq(scheduleTable.id, scheduleId))
      .returning();

    logger.info(`Updated schedule '${scheduleId}'`);

    return c.json(record[0], 200);
  },
);

/** Delete a schedule */
schedule.delete(
  "/:scheduleId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const scheduleId = c.req.param("scheduleId");
    const workspaceId = c.req.param("workspaceId")!;

    const result = await db
      .delete(scheduleTable)
      .where(
        and(
          eq(scheduleTable.id, scheduleId),
          eq(scheduleTable.workspaceId, workspaceId),
        ),
      )
      .returning();

    if (result.length === 0) {
      return c.json({ message: "Schedule not found" }, 404);
    }

    logger.info(`Deleted schedule '${scheduleId}'`);

    return c.json({ message: "Schedule deleted" });
  },
);

/** List chats for a schedule */
schedule.get(
  "/:scheduleId/chats",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const scheduleId = c.req.param("scheduleId");
    const workspaceId = c.req.param("workspaceId")!;

    // Verify schedule exists in workspace
    const scheduleRecord = await db
      .select()
      .from(scheduleTable)
      .where(
        and(
          eq(scheduleTable.id, scheduleId),
          eq(scheduleTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (scheduleRecord.length === 0) {
      return c.json({ message: "Schedule not found" }, 404);
    }

    const results = await db
      .select({
        id: chatTable.id,
        title: chatTable.title,
        createdAt: chatTable.createdAt,
        updatedAt: chatTable.updatedAt,
      })
      .from(chatTable)
      .where(eq(chatTable.scheduleId, scheduleId))
      .orderBy(desc(chatTable.createdAt));

    return c.json({ results });
  },
);

/** List runs for a schedule */
schedule.get(
  "/:scheduleId/runs",
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
    const scheduleId = c.req.param("scheduleId");
    const workspaceId = c.req.param("workspaceId")!;
    const { limit: limitStr, offset: offsetStr } = c.req.valid("query");

    const limit = Math.min(parseInt(limitStr ?? "100") || 100, 100);
    const offset = parseInt(offsetStr ?? "0") || 0;

    // Verify schedule exists in workspace
    const scheduleRecord = await db
      .select()
      .from(scheduleTable)
      .where(
        and(
          eq(scheduleTable.id, scheduleId),
          eq(scheduleTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (scheduleRecord.length === 0) {
      return c.json({ message: "Schedule not found" }, 404);
    }

    const results = await db
      .select()
      .from(scheduleRunTable)
      .where(eq(scheduleRunTable.scheduleId, scheduleId))
      .orderBy(desc(scheduleRunTable.startedAt))
      .limit(limit)
      .offset(offset);

    return c.json({ results });
  },
);

export { schedule };
