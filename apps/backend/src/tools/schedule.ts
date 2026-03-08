import { tool, type Tool } from "ai";
import { z } from "zod";
import { nanoid } from "nanoid";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  schedule as scheduleTable,
  agent as agentTable,
} from "../db/schema.ts";
import { validateCronExpression } from "../utils/cron.ts";

export function createScheduleTools(
  workspaceId: string,
): Record<string, Tool> {
  const listAgents = tool({
    description:
      "List all agents available in this workspace. Returns agent IDs, names, and descriptions. Use this to find agent IDs when creating or editing schedules.",
    inputSchema: z.object({}),
    execute: async () => {
      const agents = await db
        .select({
          id: agentTable.id,
          name: agentTable.name,
          description: agentTable.description,
        })
        .from(agentTable)
        .where(eq(agentTable.workspaceId, workspaceId))
        .orderBy(desc(agentTable.createdAt));

      return { agents, count: agents.length };
    },
  });

  const listSchedules = tool({
    description:
      "List all schedules in the current workspace. Use this to see what scheduled tasks exist, their cron expressions, and when they will run next.",
    inputSchema: z.object({
      enabledOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, only return enabled schedules"),
    }),
    execute: async ({ enabledOnly }) => {
      const conditions = [eq(scheduleTable.workspaceId, workspaceId)];
      if (enabledOnly) {
        conditions.push(eq(scheduleTable.enabled, true));
      }

      const schedules = await db
        .select({
          id: scheduleTable.id,
          name: scheduleTable.name,
          description: scheduleTable.description,
          agentId: scheduleTable.agentId,
          instruction: scheduleTable.instruction,
          cronExpression: scheduleTable.cronExpression,
          timezone: scheduleTable.timezone,
          isOneOff: scheduleTable.isOneOff,
          enabled: scheduleTable.enabled,
          maxChatsToKeep: scheduleTable.maxChatsToKeep,
          lastRunAt: scheduleTable.lastRunAt,
          nextRunAt: scheduleTable.nextRunAt,
          createdAt: scheduleTable.createdAt,
        })
        .from(scheduleTable)
        .where(and(...conditions))
        .orderBy(desc(scheduleTable.createdAt));

      return { schedules, count: schedules.length };
    },
  });

  const upsertSchedule = tool({
    description:
      "Create a new schedule or update an existing schedule. If scheduleId is provided, updates the existing schedule. If scheduleId is not provided, creates a new schedule (requires name, agentId, instruction, and cronExpression).",
    inputSchema: z.object({
      scheduleId: z
        .string()
        .optional()
        .describe(
          "The schedule ID to update. If not provided, a new schedule will be created.",
        ),
      name: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "A descriptive name for the schedule (required when creating)",
        ),
      agentId: z
        .string()
        .optional()
        .describe(
          "The ID of the agent to run (required when creating, use list-agents to find available IDs)",
        ),
      instruction: z
        .string()
        .min(1)
        .max(10000)
        .optional()
        .describe(
          "The instruction/prompt to send to the agent when the schedule runs (required when creating)",
        ),
      cronExpression: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Cron expression (required when creating, e.g., '0 9 * * *' for daily at 9 AM UTC)",
        ),
      description: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe("Optional description of what this schedule does (null to clear)"),
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone (e.g., 'America/New_York', 'Europe/London'). Defaults to 'UTC' when creating."),
      isOneOff: z
        .boolean()
        .optional()
        .describe("If true, runs once then automatically disables"),
      enabled: z
        .boolean()
        .optional()
        .describe("Whether the schedule is enabled"),
      maxChatsToKeep: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Maximum number of chat histories to retain"),
    }),
    execute: async (params) => {
      const { scheduleId, ...fields } = params;

      // Update existing schedule
      if (scheduleId) {
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
          return {
            success: false,
            error:
              "Schedule not found in this workspace. Use list-schedules to find valid IDs.",
          };
        }

        const currentSchedule = existing[0];

        // If agentId is being changed, verify new agent exists
        if (fields.agentId && fields.agentId !== currentSchedule.agentId) {
          const agentRecord = await db
            .select()
            .from(agentTable)
            .where(
              and(
                eq(agentTable.id, fields.agentId),
                eq(agentTable.workspaceId, workspaceId),
              ),
            )
            .limit(1);

          if (agentRecord.length === 0) {
            return {
              success: false,
              error:
                "Agent not found in this workspace. Use list-agents to find valid agent IDs.",
            };
          }
        }

        // Recompute nextRunAt if cron expression or timezone changed
        let nextRunAt: Date | null = null;
        const cronExpression =
          fields.cronExpression ?? currentSchedule.cronExpression;
        const timezone = fields.timezone ?? currentSchedule.timezone;

        if (fields.cronExpression || fields.timezone) {
          nextRunAt = validateCronExpression(cronExpression, timezone);
          if (!nextRunAt) {
            return {
              success: false,
              error:
                "Invalid cron expression or timezone. Example: '0 9 * * *' for daily at 9 AM.",
            };
          }
        }

        // Build update object with only provided fields
        const updateData: Record<string, unknown> = {
          updatedAt: new Date(),
        };

        if (fields.name !== undefined) updateData.name = fields.name;
        if (fields.agentId !== undefined) updateData.agentId = fields.agentId;
        if (fields.instruction !== undefined)
          updateData.instruction = fields.instruction;
        if (fields.cronExpression !== undefined)
          updateData.cronExpression = fields.cronExpression;
        if (fields.description !== undefined)
          updateData.description = fields.description;
        if (fields.timezone !== undefined)
          updateData.timezone = fields.timezone;
        if (fields.isOneOff !== undefined)
          updateData.isOneOff = fields.isOneOff;
        if (fields.enabled !== undefined) updateData.enabled = fields.enabled;
        if (fields.maxChatsToKeep !== undefined)
          updateData.maxChatsToKeep = fields.maxChatsToKeep;
        if (nextRunAt) updateData.nextRunAt = nextRunAt;

        const record = await db
          .update(scheduleTable)
          .set(updateData)
          .where(eq(scheduleTable.id, scheduleId))
          .returning();

        return {
          success: true,
          schedule: record[0],
        };
      }

      // Create new schedule — validate required fields
      const { name, agentId, instruction, cronExpression } = fields;

      if (!name || !agentId || !instruction || !cronExpression) {
        return {
          error:
            "name, agentId, instruction, and cronExpression are required when creating a new schedule",
        };
      }

      const timezone = fields.timezone ?? "UTC";
      const isOneOff = fields.isOneOff ?? false;
      const enabled = fields.enabled ?? true;
      const maxChatsToKeep = fields.maxChatsToKeep ?? 50;

      // Verify agent exists in workspace
      const agentRecord = await db
        .select()
        .from(agentTable)
        .where(
          and(
            eq(agentTable.id, agentId),
            eq(agentTable.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (agentRecord.length === 0) {
        return {
          success: false,
          error:
            "Agent not found in this workspace. Use list-agents to find valid agent IDs.",
        };
      }

      // Validate cron expression
      const nextRunAt = validateCronExpression(cronExpression, timezone);
      if (!nextRunAt) {
        return {
          success: false,
          error:
            "Invalid cron expression or timezone. Example: '0 9 * * *' for daily at 9 AM.",
        };
      }

      const id = nanoid();
      const now = new Date();

      const record = await db
        .insert(scheduleTable)
        .values({
          id,
          workspaceId,
          agentId,
          name,
          description: fields.description || null,
          instruction,
          cronExpression,
          timezone,
          isOneOff,
          enabled,
          maxChatsToKeep,
          nextRunAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return {
        success: true,
        schedule: record[0],
      };
    },
  });

  const deleteSchedule = tool({
    description: "Delete a schedule.",
    inputSchema: z.object({
      scheduleId: z
        .string()
        .describe(
          "The ID of the schedule to delete (use list-schedules to find IDs)",
        ),
    }),
    execute: async ({ scheduleId }) => {
      const result = await db
        .delete(scheduleTable)
        .where(
          and(
            eq(scheduleTable.id, scheduleId),
            eq(scheduleTable.workspaceId, workspaceId),
          ),
        )
        .returning({ id: scheduleTable.id });

      if (result.length === 0) {
        return { error: "Schedule not found" };
      }

      return { success: true };
    },
  });

  return {
    listAgents,
    listSchedules,
    upsertSchedule,
    deleteSchedule,
  };
}
