import { tool } from "ai";
import { z } from "zod";
import { nanoid } from "nanoid";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  schedule as scheduleTable,
  agent as agentTable,
} from "../db/schema.ts";
import { validateCronExpression } from "../utils/cron.ts";

// Tool 1: List agents (needed to get agent IDs for createSchedule/editSchedule)
export const createListAgentsTool = (workspaceId: string) =>
  tool({
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

// Tool 2: List schedules
export const createListSchedulesTool = (workspaceId: string) =>
  tool({
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

// Tool 3: Create schedule
export const createScheduleTool = (workspaceId: string) =>
  tool({
    description:
      "Create a new schedule that runs an agent at specified times. Requires an agent ID, instruction, and cron expression.",
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(100)
        .describe("A descriptive name for the schedule"),
      agentId: z
        .string()
        .describe(
          "The ID of the agent to run (use list-agents to find available IDs)",
        ),
      instruction: z
        .string()
        .min(1)
        .max(10000)
        .describe(
          "The instruction/prompt to send to the agent when the schedule runs",
        ),
      cronExpression: z
        .string()
        .min(1)
        .describe("Cron expression (e.g., '0 9 * * *' for daily at 9 AM UTC)"),
      description: z
        .string()
        .max(500)
        .optional()
        .describe("Optional description of what this schedule does"),
      timezone: z
        .string()
        .optional()
        .default("UTC")
        .describe("IANA timezone (e.g., 'America/New_York', 'Europe/London')"),
      isOneOff: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, runs once then automatically disables"),
      enabled: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether the schedule is enabled"),
      maxChatsToKeep: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .default(50)
        .describe("Maximum number of chat histories to retain"),
    }),
    execute: async (params) => {
      const {
        name,
        agentId,
        instruction,
        cronExpression,
        description,
        timezone = "UTC",
        isOneOff = false,
        enabled = true,
        maxChatsToKeep = 50,
      } = params;

      // 1. Verify agent exists in workspace
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

      // 2. Validate cron expression
      const nextRunAt = validateCronExpression(cronExpression, timezone);
      if (!nextRunAt) {
        return {
          success: false,
          error:
            "Invalid cron expression or timezone. Example: '0 9 * * *' for daily at 9 AM.",
        };
      }

      // 3. Insert schedule
      const id = nanoid();
      const now = new Date();

      const record = await db
        .insert(scheduleTable)
        .values({
          id,
          workspaceId,
          agentId,
          name,
          description: description || null,
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

// Tool 4: Edit schedule
export const createEditScheduleTool = (workspaceId: string) =>
  tool({
    description:
      "Update an existing schedule's properties. Provide the schedule ID and the fields to update.",
    inputSchema: z.object({
      scheduleId: z
        .string()
        .describe(
          "The ID of the schedule to update (use list-schedules to find IDs)",
        ),
      name: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe("New name for the schedule"),
      agentId: z
        .string()
        .optional()
        .describe("New agent ID (use list-agents to find available IDs)"),
      instruction: z
        .string()
        .min(1)
        .max(10000)
        .optional()
        .describe("New instruction/prompt"),
      cronExpression: z
        .string()
        .min(1)
        .optional()
        .describe("New cron expression"),
      description: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe("New description (null to clear)"),
      timezone: z.string().optional().describe("New IANA timezone"),
      isOneOff: z.boolean().optional().describe("New one-off setting"),
      enabled: z.boolean().optional().describe("New enabled status"),
      maxChatsToKeep: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("New max chats to keep"),
    }),
    execute: async (params) => {
      const { scheduleId, ...updates } = params;

      // 1. Verify schedule exists in workspace
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

      // 2. If agentId is being changed, verify new agent exists
      if (updates.agentId && updates.agentId !== currentSchedule.agentId) {
        const agentRecord = await db
          .select()
          .from(agentTable)
          .where(
            and(
              eq(agentTable.id, updates.agentId),
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

      // 3. Recompute nextRunAt if cron expression or timezone changed
      let nextRunAt: Date | null = null;
      const cronExpression =
        updates.cronExpression ?? currentSchedule.cronExpression;
      const timezone = updates.timezone ?? currentSchedule.timezone;

      if (updates.cronExpression || updates.timezone) {
        nextRunAt = validateCronExpression(cronExpression, timezone);
        if (!nextRunAt) {
          return {
            success: false,
            error:
              "Invalid cron expression or timezone. Example: '0 9 * * *' for daily at 9 AM.",
          };
        }
      }

      // 4. Build update object with only provided fields
      const updateData: Record<string, unknown> = {
        updatedAt: new Date(),
      };

      if (updates.name !== undefined) updateData.name = updates.name;
      if (updates.agentId !== undefined) updateData.agentId = updates.agentId;
      if (updates.instruction !== undefined)
        updateData.instruction = updates.instruction;
      if (updates.cronExpression !== undefined)
        updateData.cronExpression = updates.cronExpression;
      if (updates.description !== undefined)
        updateData.description = updates.description;
      if (updates.timezone !== undefined)
        updateData.timezone = updates.timezone;
      if (updates.isOneOff !== undefined)
        updateData.isOneOff = updates.isOneOff;
      if (updates.enabled !== undefined) updateData.enabled = updates.enabled;
      if (updates.maxChatsToKeep !== undefined)
        updateData.maxChatsToKeep = updates.maxChatsToKeep;
      if (nextRunAt) updateData.nextRunAt = nextRunAt;

      // 5. Update schedule
      const record = await db
        .update(scheduleTable)
        .set(updateData)
        .where(eq(scheduleTable.id, scheduleId))
        .returning();

      return {
        success: true,
        schedule: record[0],
      };
    },
  });
