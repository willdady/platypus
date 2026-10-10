import { tool, type Tool } from "ai";
import { z } from "zod";
import {
  cronTriggerConfigSchema,
  eventTriggerFiltersSchema,
  eventTriggerEventSchema,
  type CronTriggerConfig,
  type EventTriggerConfig,
} from "@platypus/schemas";
import { db } from "../index.ts";
import { buildResourceUrl } from "../utils/resource-url.ts";
import { listScoped } from "../services/scoped-resource.ts";
import {
  createTrigger,
  deleteTrigger as deleteTriggerService,
  FIRED_ONE_OFF_TTL_DAYS,
  getTrigger as getTriggerService,
  listTriggers as listTriggersService,
  toPublicTrigger,
  updateTrigger,
} from "../services/trigger.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { getCurrentTime } from "./time.ts";
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

  /**
   * A written Trigger's next run, in UTC and on the wall clock of its own
   * timezone, so the model can check it against the instant the User asked
   * for. Empty for a Trigger with no next run.
   */
  const describeNextRun = (record: {
    type: string;
    config: unknown;
    nextRunAt: Date | null;
  }) => {
    if (record.type !== "cron" || !record.nextRunAt) return {};
    const { timezone } = record.config as CronTriggerConfig;
    return {
      nextRunAt: record.nextRunAt.toISOString(),
      nextRunAtLocal: new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: timezone,
      }).format(record.nextRunAt),
    };
  };

  /** Translates the Trigger module's typed errors into a Tool result. */
  const toToolError = (error: unknown) => {
    if (error instanceof ValidationError || error instanceof NotFoundError) {
      const hint = error.message.startsWith("Agent not found")
        ? ". Use listAgents to find valid agent IDs."
        : "";
      return { success: false, error: error.message + hint };
    }
    throw error;
  };

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
      "List all triggers in the current workspace, including one-off triggers that have already fired. Returns summary information for each trigger, with the status of its last run (null before it has run). Use getTrigger to get full details including instruction and config.",
    inputSchema: z.object({
      enabledOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, only return enabled triggers"),
    }),
    execute: async ({ enabledOnly }) => {
      const rows = await listTriggersService(ctx, {
        enabledOnly,
        includeFired: true,
      });
      const triggers = rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        agentId: row.agentId,
        type: row.type,
        enabled: row.enabled,
        ...(row.type === "cron" && {
          isOneOff: (row.config as CronTriggerConfig).isOneOff === true,
        }),
        nextRunAt: row.nextRunAt,
        lastRunAt: row.lastRunAt,
        firedAt: row.firedAt,
        lastRunStatus: row.lastRunStatus,
        createdAt: row.createdAt,
      }));

      return { triggers, count: triggers.length };
    },
  });

  const getTrigger = tool({
    description: "Get the full details of a trigger by ID.",
    inputSchema: z.object({
      triggerId: z.string().describe("The ID of the trigger to retrieve"),
    }),
    execute: async ({ triggerId }) => {
      try {
        return {
          trigger: toPublicTrigger(await getTriggerService(ctx, triggerId)),
        };
      } catch (error) {
        if (error instanceof NotFoundError) {
          return {
            error:
              "Trigger not found in this workspace. Use listTriggers to find valid IDs.",
          };
        }
        throw error;
      }
    },
  });

  const upsertTrigger = tool({
    description:
      "Create a new trigger or update an existing trigger. If triggerId is provided, updates the existing trigger. If triggerId is not provided, creates a new trigger (requires name, agentId, instruction, type, and config). " +
      "For something the User wants done once (a reminder, a one-time task), create a cron trigger with config.isOneOff set to true: it fires at the first time its cron expression matches, then is spent and cannot be re-enabled. Use getCurrentTime to work out dates such as 'tomorrow'. " +
      "If you don't know the User's timezone, ask them rather than assuming UTC, and pass it as config.timezone. " +
      "A cron trigger's result carries nextRunAt (UTC) and nextRunAtLocal (in its timezone): check it is the instant the User asked for. Cron has no year, so a date already past this year runs next year.",
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
          "The ID of the agent to run (required when creating, use listAgents to find available IDs)",
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
          isOneOff: z
            .boolean()
            .optional()
            .describe(
              `Cron triggers only: if true, the trigger fires once at the next time its cron expression matches, then is disabled for good and deleted ${FIRED_ONE_OFF_TTL_DAYS} days after its run ends. Defaults to false (recurring).`,
            ),
          events: z
            .array(eventTriggerEventSchema)
            .optional()
            .describe(
              `Array of event names for event triggers. Allowed values: ${eventTriggerEventSchema.options.join(", ")}`,
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
        .describe(
          "Minimum number of recent run records to keep; runs inside the run-rate breaker's window are retained beyond it",
        ),
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
            trigger: toPublicTrigger(record),
            ...describeNextRun(record),
            ...(url && { url }),
          };
        } catch (error) {
          return toToolError(error);
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

      try {
        const record = await createTrigger(ctx, {
          agentId,
          type,
          name,
          description: fields.description,
          instruction,
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
          `triggers/${record.id}`,
        );

        return {
          success: true,
          trigger: toPublicTrigger(record),
          ...describeNextRun(record),
          ...(url && { url }),
        };
      } catch (error) {
        return toToolError(error);
      }
    },
  });

  const deleteTrigger = tool({
    description: "Delete a trigger.",
    inputSchema: z.object({
      triggerId: z
        .string()
        .describe(
          "The ID of the trigger to delete (use listTriggers to find IDs)",
        ),
      label: z.string().describe("The trigger name (for display purposes)"),
    }),
    execute: async ({ triggerId }) => {
      try {
        if (!(await deleteTriggerService(ctx, triggerId))) {
          return { error: "Trigger not found" };
        }
      } catch (error) {
        // An Inbound Trigger is refused here, as on create and edit.
        return toToolError(error);
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
    // The Time Tool set's own tool under the same name, so an Agent holding
    // both sees it once.
    getCurrentTime,
  };
}
