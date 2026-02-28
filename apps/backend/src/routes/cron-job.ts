import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { nanoid } from "nanoid";
import { Cron } from "croner";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../index.ts";
import {
  cronJob as cronJobTable,
  chat as chatTable,
  agent as agentTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { cronJobCreateSchema, cronJobUpdateSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceOwner,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";
import { triggerCronJob } from "../services/cron-execution.ts";

const cronJob = new Hono<{ Variables: Variables }>();

// Helper to validate cron expression and compute next run
const validateAndComputeNextRun = (
  cronExpression: string,
  timezone: string,
): Date | null => {
  try {
    const cron = new Cron(cronExpression, { timezone });
    const nextRun = cron.nextRun();
    return nextRun;
  } catch (error) {
    return null;
  }
};

/** List all cron jobs in workspace */
cronJob.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const results = await db
      .select()
      .from(cronJobTable)
      .where(eq(cronJobTable.workspaceId, workspaceId))
      .orderBy(desc(cronJobTable.createdAt));
    return c.json({ results });
  },
);

/** Get a cron job by ID */
cronJob.get(
  "/:cronJobId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const cronJobId = c.req.param("cronJobId");
    const workspaceId = c.req.param("workspaceId")!;

    const record = await db
      .select()
      .from(cronJobTable)
      .where(
        and(
          eq(cronJobTable.id, cronJobId),
          eq(cronJobTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (record.length === 0) {
      return c.json({ message: "Cron job not found" }, 404);
    }

    return c.json(record[0]);
  },
);

/** Create a new cron job */
cronJob.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", cronJobCreateSchema),
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
    const nextRunAt = validateAndComputeNextRun(
      data.cronExpression,
      data.timezone || "UTC",
    );

    if (!nextRunAt) {
      return c.json({ message: "Invalid cron expression or timezone" }, 400);
    }

    const id = nanoid();
    const now = new Date();

    const record = await db
      .insert(cronJobTable)
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
      `Created cron job '${id}' in workspace '${workspaceId}' - next run at ${nextRunAt.toISOString()}`,
    );

    return c.json(record[0], 201);
  },
);

/** Update a cron job */
cronJob.put(
  "/:cronJobId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", cronJobUpdateSchema),
  async (c) => {
    const cronJobId = c.req.param("cronJobId");
    const workspaceId = c.req.param("workspaceId")!;
    const data = c.req.valid("json");

    // Verify cron job exists in workspace
    const existing = await db
      .select()
      .from(cronJobTable)
      .where(
        and(
          eq(cronJobTable.id, cronJobId),
          eq(cronJobTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      return c.json({ message: "Cron job not found" }, 404);
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
      nextRunAt = validateAndComputeNextRun(cronExpression, timezone);
      if (!nextRunAt) {
        return c.json({ message: "Invalid cron expression or timezone" }, 400);
      }
    }

    const updateData: Record<string, any> = {
      ...data,
      updatedAt: new Date(),
    };

    if (nextRunAt) {
      updateData.nextRunAt = nextRunAt;
    }

    const record = await db
      .update(cronJobTable)
      .set(updateData)
      .where(eq(cronJobTable.id, cronJobId))
      .returning();

    logger.info(`Updated cron job '${cronJobId}'`);

    return c.json(record[0], 200);
  },
);

/** Delete a cron job */
cronJob.delete(
  "/:cronJobId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const cronJobId = c.req.param("cronJobId");
    const workspaceId = c.req.param("workspaceId")!;

    const result = await db
      .delete(cronJobTable)
      .where(
        and(
          eq(cronJobTable.id, cronJobId),
          eq(cronJobTable.workspaceId, workspaceId),
        ),
      )
      .returning();

    if (result.length === 0) {
      return c.json({ message: "Cron job not found" }, 404);
    }

    logger.info(`Deleted cron job '${cronJobId}'`);

    return c.json({ message: "Cron job deleted" });
  },
);

/** List chats for a cron job */
cronJob.get(
  "/:cronJobId/chats",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const cronJobId = c.req.param("cronJobId");
    const workspaceId = c.req.param("workspaceId")!;

    // Verify cron job exists in workspace
    const cronJobRecord = await db
      .select()
      .from(cronJobTable)
      .where(
        and(
          eq(cronJobTable.id, cronJobId),
          eq(cronJobTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (cronJobRecord.length === 0) {
      return c.json({ message: "Cron job not found" }, 404);
    }

    const results = await db
      .select({
        id: chatTable.id,
        title: chatTable.title,
        createdAt: chatTable.createdAt,
        updatedAt: chatTable.updatedAt,
      })
      .from(chatTable)
      .where(eq(chatTable.cronJobId, cronJobId))
      .orderBy(desc(chatTable.createdAt));

    return c.json({ results });
  },
);

/** Manually trigger a cron job */
cronJob.post(
  "/:cronJobId/trigger",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const cronJobId = c.req.param("cronJobId");
    const workspaceId = c.req.param("workspaceId")!;

    // Verify cron job exists in workspace
    const cronJobRecord = await db
      .select()
      .from(cronJobTable)
      .where(
        and(
          eq(cronJobTable.id, cronJobId),
          eq(cronJobTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (cronJobRecord.length === 0) {
      return c.json({ message: "Cron job not found" }, 404);
    }

    const job = cronJobRecord[0];

    if (!job.enabled) {
      return c.json({ message: "Cron job is disabled" }, 400);
    }

    // Trigger the cron job execution
    try {
      const chatId = await triggerCronJob(job);
      logger.info(
        `Manually triggered cron job '${cronJobId}' - created chat '${chatId}'`,
      );
      return c.json({ message: "Cron job triggered", chatId });
    } catch (error) {
      logger.error({ error, cronJobId }, "Failed to trigger cron job");
      return c.json({ message: "Failed to trigger cron job" }, 500);
    }
  },
);

export { cronJob };
