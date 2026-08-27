import { tool, type Tool } from "ai";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import {
  cronTriggerConfigSchema,
  eventTriggerFiltersSchema,
  webhookEventSchema,
  type CronTriggerConfig,
  type EventTriggerConfig,
} from "@platypus/schemas";
import { db } from "../index.ts";
import { trigger as triggerTable } from "../db/schema.ts";
import { buildResourceUrl } from "../utils/resource-url.ts";
import { listScoped, resolveScoped } from "../services/scoped-resource.ts";
import { createTrigger, updateTrigger } from "../services/trigger.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import type { ScopeContext } from "../scope.ts";

export function createTriggerTools(
  workspaceId: string,
  orgId: string,
  frontendUrl: string | undefined,
): Record<string, Tool> {
  // A trigger may point at any Agent this Workspace can run — its own, or a
  // Shared one attached to it (ADR-0007), which is exactly what the Chat turn
  // resolves when the trigger fires.
  const ctx: ScopeContext = { orgId, workspaceId };

  const listAgents = tool({
    description:
      "List all agents available in this workspace, including shared agents attached to it. Returns agent IDs, names, and descriptions. Use this to find agent IDs when creating or editing triggers.",
    inputSchema: z.object({}),
    execute: async () => {
      const scoped = await listScoped(db, "agent", ctx);
      // Newest first across both scopes — `listScoped` returns the Workspace
      // rows then the attached Shared ones, so the ordering is applied here.
      const agents = scoped
        .map(({ row }) => row)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
        }));

      return { agents, count: agents.length };
    },
  });

  const listTriggers = tool({
    description:
      "List all triggers in the current workspace. Returns summary information for each trigger. Use getTrigger to get full details including instruction and config.",
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
          enabled: triggerTable.enabled,
          nextRunAt: triggerTable.nextRunAt,
          lastRunAt: triggerTable.lastRunAt,
          createdAt: triggerTable.createdAt,
        })
        .from(triggerTable)
        .where(and(...conditions))
        .orderBy(desc(triggerTable.createdAt));

      return { triggers, count: triggers.length };
    },
  });

  const getTrigger = tool({
    description: "Get the full details of a trigger by ID.",
    inputSchema: z.object({
      triggerId: z.string().describe("The ID of the trigger to retrieve"),
    }),
    execute: async ({ triggerId }) => {
      const result = await db
        .select()
        .from(triggerTable)
        .where(
          and(
            eq(triggerTable.id, triggerId),
            eq(triggerTable.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (result.length === 0) {
        return {
          error:
            "Trigger not found in this workspace. Use listTriggers to find valid IDs.",
        };
      }

      return { trigger: result[0] };
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
          cronExpression: cronTriggerConfigSchema.shape.cronExpression
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
            .array(webhookEventSchema)
            .optional()
            .describe(
              `Array of event names for event triggers. Allowed values: ${webhookEventSchema.options.join(", ")}`,
            ),
          filters: eventTriggerFiltersSchema
            .optional()
            .describe(
              "Optional filters to narrow which events trigger this agent: boardId, columnId, and/or changedFields (changedFields only applies to card.updated).",
            ),
        })
        .optional()
        .describe(
          "Trigger configuration. For cron type: requires cronExpression. For event type: requires events array.",
        ),
      description: z
        .string()
        .min(1)
        .max(500)
        .describe("Description of what this trigger does"),
      enabled: z
        .boolean()
        .optional()
        .describe("Whether the trigger is enabled"),
      maxRunsToKeep: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Maximum number of run records to retain"),
      search: z
        .boolean()
        .optional()
        .describe("If true, enables web search for the LLM"),
      includeMemories: z
        .boolean()
        .optional()
        .describe(
          "If true, the trigger's runs include the user's recent memory summaries in the system prompt. Defaults to false, so a run's prompt does not vary with unrelated chat activity.",
        ),
    }),
    execute: async (params) => {
      const { triggerId, label: _label, ...fields } = params;
      const config = fields.config as
        (CronTriggerConfig | EventTriggerConfig) | undefined;

      // Update existing trigger
      if (triggerId) {
        // A new agentId must be usable here: workspace-scoped, or a Shared
        // one attached to this Workspace (ADR-0007) — see the create branch
        // below. `updateTrigger` itself errors if the trigger doesn't exist.
        if (fields.agentId) {
          const agentRecord = await resolveScoped(
            db,
            "agent",
            fields.agentId,
            ctx,
          );

          if (!agentRecord) {
            return {
              success: false,
              error:
                "Agent not found in this workspace. Use list-agents to find valid agent IDs.",
            };
          }
        }

        try {
          const record = await updateTrigger(ctx, triggerId, {
            agentId: fields.agentId,
            type: fields.type,
            name: fields.name,
            description: fields.description,
            instruction: fields.instruction,
            enabled: fields.enabled,
            maxRunsToKeep: fields.maxRunsToKeep,
            search: fields.search,
            includeMemories: fields.includeMemories,
            config,
          });

          const url = buildResourceUrl(
            frontendUrl,
            orgId,
            workspaceId,
            `triggers/${triggerId}`,
          );

          return {
            success: true,
            trigger: record,
            ...(url && { url }),
          };
        } catch (error) {
          if (
            error instanceof ValidationError ||
            error instanceof NotFoundError
          ) {
            return { success: false, error: error.message };
          }
          throw error;
        }
      }

      // Create new trigger — validate required fields
      const { name, agentId, instruction, type } = fields;

      if (!name || !agentId || !instruction || !type || !config) {
        return {
          error:
            "name, agentId, instruction, type, and config are required when creating a new trigger",
        };
      }

      // Verify the agent is usable in this workspace
      const agentRecord = await resolveScoped(db, "agent", agentId, ctx);

      if (!agentRecord) {
        return {
          success: false,
          error:
            "Agent not found in this workspace. Use list-agents to find valid agent IDs.",
        };
      }

      try {
        const record = await createTrigger(ctx, {
          agentId,
          type,
          name,
          description: fields.description,
          instruction,
          enabled: fields.enabled ?? true,
          maxRunsToKeep: fields.maxRunsToKeep ?? 10,
          search: fields.search ?? false,
          includeMemories: fields.includeMemories ?? false,
          config,
        });

        const url = buildResourceUrl(
          frontendUrl,
          orgId,
          workspaceId,
          `triggers/${record.id}`,
        );

        return {
          success: true,
          trigger: record,
          ...(url && { url }),
        };
      } catch (error) {
        if (error instanceof ValidationError) {
          return { success: false, error: error.message };
        }
        throw error;
      }
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
    getTrigger,
    upsertTrigger,
    deleteTrigger,
  };
}
