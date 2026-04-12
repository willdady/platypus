import { tool, type Tool } from "ai";
import { z } from "zod";
import { nanoid } from "nanoid";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.ts";
import { trigger as triggerTable, agent as agentTable } from "../db/schema.ts";
import { validateCronExpression } from "../utils/cron.ts";
import { buildResourceUrl } from "../utils/resource-url.ts";

export function createTriggerTools(
  workspaceId: string,
  orgId: string,
  frontendUrl: string | undefined,
): Record<string, Tool> {
  const listAgents = tool({
    description:
      "List all agents available in this workspace. Returns agent IDs, names, and descriptions. Use this to find agent IDs when creating or editing triggers.",
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

  const listTriggers = tool({
    description:
      "List all triggers in the current workspace. Use this to see what triggers exist, their type (cron or event), configuration, and when they will run next.",
    inputSchema: z.object({
      enabledOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, only return enabled triggers"),
    }),
    execute: async ({ enabledOnly }) => {
      const conditions = [eq(triggerTable.workspaceId, workspaceId)];
      if (enabledOnly) {
        conditions.push(eq(triggerTable.enabled, true));
      }

      const triggers = await db
        .select({
          id: triggerTable.id,
          name: triggerTable.name,
          description: triggerTable.description,
          agentId: triggerTable.agentId,
          type: triggerTable.type,
          instruction: triggerTable.instruction,
          enabled: triggerTable.enabled,
          maxChatsToKeep: triggerTable.maxChatsToKeep,
          search: triggerTable.search,
          config: triggerTable.config,
          lastRunAt: triggerTable.lastRunAt,
          nextRunAt: triggerTable.nextRunAt,
          createdAt: triggerTable.createdAt,
        })
        .from(triggerTable)
        .where(and(...conditions))
        .orderBy(desc(triggerTable.createdAt));

      return { triggers, count: triggers.length };
    },
  });

  const upsertTrigger = tool({
    description:
      "Create a new trigger or update an existing trigger. If triggerId is provided, updates the existing trigger. If triggerId is not provided, creates a new trigger (requires name, agentId, instruction, type, and config).",
    inputSchema: z.object({
      triggerId: z
        .string()
        .optional()
        .describe(
          "The trigger ID to update. If not provided, a new trigger will be created.",
        ),
      label: z
        .string()
        .describe(
          "The trigger name (for display purposes, required when updating by triggerId)",
        ),
      name: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "A descriptive name for the trigger (required when creating)",
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
          "The instruction/prompt to send to the agent when the trigger fires (required when creating)",
        ),
      type: z
        .enum(["cron", "event"])
        .optional()
        .describe(
          "The trigger type: 'cron' for scheduled triggers or 'event' for event-based triggers (required when creating)",
        ),
      config: z
        .object({
          cronExpression: z
            .string()
            .optional()
            .describe(
              "Cron expression for cron triggers (e.g., '0 9 * * *' for daily at 9 AM UTC)",
            ),
          timezone: z
            .string()
            .optional()
            .describe(
              "IANA timezone for cron triggers (e.g., 'America/New_York'). Defaults to 'UTC'.",
            ),
          events: z
            .array(z.string())
            .optional()
            .describe(
              "Array of event names for event triggers (e.g., ['card.created', 'card.updated'])",
            ),
          filters: z
            .object({
              boardId: z
                .string()
                .optional()
                .describe("Filter card events to a specific board"),
            })
            .optional()
            .describe(
              "Optional filters to narrow which events trigger this agent",
            ),
        })
        .optional()
        .describe(
          "Trigger configuration. For cron type: requires cronExpression. For event type: requires events array.",
        ),
      description: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe(
          "Optional description of what this trigger does (null to clear)",
        ),
      enabled: z
        .boolean()
        .optional()
        .describe("Whether the trigger is enabled"),
      maxChatsToKeep: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Maximum number of chat histories to retain"),
      search: z
        .boolean()
        .optional()
        .describe("If true, enables web search for the LLM"),
    }),
    execute: async (params) => {
      const { triggerId, label: _label, ...fields } = params;

      // Update existing trigger
      if (triggerId) {
        const existing = await db
          .select()
          .from(triggerTable)
          .where(
            and(
              eq(triggerTable.id, triggerId),
              eq(triggerTable.workspaceId, workspaceId),
            ),
          )
          .limit(1);

        if (existing.length === 0) {
          return {
            success: false,
            error:
              "Trigger not found in this workspace. Use list-triggers to find valid IDs.",
          };
        }

        const currentTrigger = existing[0];

        // If agentId is being changed, verify new agent exists
        if (fields.agentId && fields.agentId !== currentTrigger.agentId) {
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

        const effectiveType = fields.type ?? currentTrigger.type;
        const effectiveConfig = fields.config
          ? {
              ...(currentTrigger.config as Record<string, unknown>),
              ...fields.config,
            }
          : (currentTrigger.config as Record<string, unknown>);

        // Validate config based on type
        if (effectiveType === "cron") {
          const cronExpression = effectiveConfig.cronExpression as
            | string
            | undefined;
          if (!cronExpression) {
            return {
              success: false,
              error: "Cron triggers require config.cronExpression.",
            };
          }
          const timezone = (effectiveConfig.timezone as string) ?? "UTC";
          const nextRunAt = validateCronExpression(cronExpression, timezone);
          if (!nextRunAt) {
            return {
              success: false,
              error:
                "Invalid cron expression or timezone. Example: '0 9 * * *' for daily at 9 AM.",
            };
          }
        } else if (effectiveType === "event") {
          const events = effectiveConfig.events as string[] | undefined;
          if (!events || events.length === 0) {
            return {
              success: false,
              error:
                "Event triggers require config.events array with at least one event.",
            };
          }
        } else {
          return {
            success: false,
            error: "Invalid trigger type. Must be 'cron' or 'event'.",
          };
        }

        // Build update payload from provided fields
        const updateData: Record<string, unknown> = {
          updatedAt: new Date(),
        };
        if (fields.name !== undefined) updateData.name = fields.name;
        if (fields.agentId !== undefined) updateData.agentId = fields.agentId;
        if (fields.instruction !== undefined)
          updateData.instruction = fields.instruction;
        if (fields.description !== undefined)
          updateData.description = fields.description;
        if (fields.enabled !== undefined) updateData.enabled = fields.enabled;
        if (fields.maxChatsToKeep !== undefined)
          updateData.maxChatsToKeep = fields.maxChatsToKeep;
        if (fields.search !== undefined) updateData.search = fields.search;
        if (fields.type !== undefined) updateData.type = fields.type;
        if (fields.config !== undefined) updateData.config = effectiveConfig;

        // Set nextRunAt based on type
        if (effectiveType === "cron") {
          const cronExpression = effectiveConfig.cronExpression as string;
          const timezone = (effectiveConfig.timezone as string) ?? "UTC";
          if (fields.config?.cronExpression || fields.config?.timezone)
            updateData.nextRunAt = validateCronExpression(
              cronExpression,
              timezone,
            );
        } else {
          updateData.nextRunAt = null;
        }

        const record = await db
          .update(triggerTable)
          .set(updateData)
          .where(eq(triggerTable.id, triggerId))
          .returning();

        const url = buildResourceUrl(
          frontendUrl,
          orgId,
          workspaceId,
          `triggers/${triggerId}`,
        );

        return {
          success: true,
          trigger: record[0],
          ...(url && { url }),
        };
      }

      // Create new trigger — validate required fields
      const { name, agentId, instruction, type, config } = fields;

      if (!name || !agentId || !instruction || !type || !config) {
        return {
          error:
            "name, agentId, instruction, type, and config are required when creating a new trigger",
        };
      }

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

      const enabled = fields.enabled ?? true;
      const maxChatsToKeep = fields.maxChatsToKeep ?? 10;
      const search = fields.search ?? false;
      const id = nanoid();
      const now = new Date();

      if (type === "cron") {
        const cronExpression = config.cronExpression;
        if (!cronExpression) {
          return {
            success: false,
            error: "Cron triggers require config.cronExpression.",
          };
        }

        const timezone = config.timezone ?? "UTC";
        const nextRunAt = validateCronExpression(cronExpression, timezone);
        if (!nextRunAt) {
          return {
            success: false,
            error:
              "Invalid cron expression or timezone. Example: '0 9 * * *' for daily at 9 AM.",
          };
        }

        const record = await db
          .insert(triggerTable)
          .values({
            id,
            workspaceId,
            agentId,
            type,
            name,
            description: fields.description || null,
            instruction,
            enabled,
            maxChatsToKeep,
            search,
            config: { cronExpression, timezone },
            nextRunAt,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        const url = buildResourceUrl(
          frontendUrl,
          orgId,
          workspaceId,
          `triggers/${id}`,
        );

        return {
          success: true,
          trigger: record[0],
          ...(url && { url }),
        };
      }

      if (type === "event") {
        const events = config.events;
        if (!events || events.length === 0) {
          return {
            success: false,
            error:
              "Event triggers require config.events array with at least one event.",
          };
        }

        const eventConfig: Record<string, unknown> = { events };
        if (config.filters) eventConfig.filters = config.filters;

        const record = await db
          .insert(triggerTable)
          .values({
            id,
            workspaceId,
            agentId,
            type,
            name,
            description: fields.description || null,
            instruction,
            enabled,
            maxChatsToKeep,
            search,
            config: eventConfig,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        const url = buildResourceUrl(
          frontendUrl,
          orgId,
          workspaceId,
          `triggers/${id}`,
        );

        return {
          success: true,
          trigger: record[0],
          ...(url && { url }),
        };
      }

      return {
        success: false,
        error: "Invalid trigger type. Must be 'cron' or 'event'.",
      };
    },
  });

  const deleteTrigger = tool({
    description: "Delete a trigger.",
    inputSchema: z.object({
      triggerId: z
        .string()
        .describe(
          "The ID of the trigger to delete (use list-triggers to find IDs)",
        ),
      label: z.string().describe("The trigger name (for display purposes)"),
    }),
    execute: async ({ triggerId }) => {
      const result = await db
        .delete(triggerTable)
        .where(
          and(
            eq(triggerTable.id, triggerId),
            eq(triggerTable.workspaceId, workspaceId),
          ),
        )
        .returning({ id: triggerTable.id });

      if (result.length === 0) {
        return { error: "Trigger not found" };
      }

      return { success: true };
    },
  });

  return {
    listAgents,
    listTriggers,
    upsertTrigger,
    deleteTrigger,
  };
}
