import { nanoid } from "nanoid";
import { and, desc, eq, notInArray, type Column } from "drizzle-orm";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";
import { generateText, stepCountIs, type LanguageModel } from "ai";
import { db } from "../index.ts";
import {
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  chat as chatTable,
  agent as agentTable,
  workspace as workspaceTable,
  provider as providerTable,
} from "../db/schema.ts";
import {
  createModel,
  loadTools,
  resolveGenerationConfig,
  loadSkills,
  fetchUserContexts,
  fetchFormattedMemories,
  prepareAgentTools,
  createSearchTools,
} from "./chat-execution.ts";
import { logger } from "../logger.ts";
import { validateCronExpression } from "../utils/cron.ts";
import type { PlatypusUIMessage } from "../types.ts";
import type {
  Provider,
  CronTriggerConfig,
  WebhookEvent,
} from "@platypus/schemas";

/**
 * Retains the newest N rows for a given foreign key and deletes the rest.
 */
async function retainNewest(
  table: PgTable,
  fkColumn: PgColumn,
  idColumn: PgColumn,
  orderColumn: Column,
  fkValue: string,
  limit: number,
  label: string,
): Promise<void> {
  const toKeep = await db
    .select({ id: idColumn })
    .from(table)
    .where(eq(fkColumn, fkValue))
    .orderBy(desc(orderColumn))
    .limit(limit);

  if (toKeep.length < limit) return;

  const idsToKeep = toKeep.map((r) => r.id as string);
  const deleted = await db
    .delete(table)
    .where(and(eq(fkColumn, fkValue), notInArray(idColumn, idsToKeep)))
    .returning({ id: idColumn });

  if (deleted.length > 0) {
    logger.info(
      {
        triggerId: fkValue,
        deletedCount: deleted.length,
        maxChatsToKeep: limit,
      },
      `Cleaned up old ${label}`,
    );
  }
}

export type EventContext = {
  eventType: WebhookEvent;
  eventData: unknown;
};

/**
 * Executes a trigger by running the agent with the configured instruction.
 * For event triggers, event context is prepended to the instruction.
 * Returns the created chat ID.
 */
export const executeTrigger = async (
  trigger: typeof triggerTable.$inferSelect,
  eventContext?: EventContext,
): Promise<string> => {
  const { id, workspaceId, agentId, instruction } = trigger;

  // Create a trigger run record (starts as "running" since execution begins immediately)
  const runId = nanoid();
  await db.insert(triggerRunTable).values({
    id: runId,
    triggerId: id,
    status: "running",
    eventType: eventContext?.eventType ?? null,
    eventData: eventContext?.eventData ?? null,
    startedAt: new Date(),
    createdAt: new Date(),
  });

  // Helper to update run status
  const updateRunStatus = async (
    status: "running" | "success" | "failed",
    data?: { chatId?: string; errorMessage?: string },
  ) => {
    await db
      .update(triggerRunTable)
      .set({
        status,
        chatId: data?.chatId ?? null,
        errorMessage: data?.errorMessage ?? null,
        completedAt:
          status === "success" || status === "failed" ? new Date() : null,
      })
      .where(eq(triggerRunTable.id, runId));
  };

  // 1. Fetch agent and workspace in parallel
  const [agentRecord, workspaceRecord] = await Promise.all([
    db.select().from(agentTable).where(eq(agentTable.id, agentId)).limit(1),
    db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, workspaceId))
      .limit(1),
  ]);

  if (agentRecord.length === 0) {
    const errorMsg = `Agent '${agentId}' not found for trigger '${id}'`;
    await updateRunStatus("failed", { errorMessage: errorMsg });
    throw new Error(errorMsg);
  }
  const agent = agentRecord[0];

  if (workspaceRecord.length === 0) {
    const errorMsg = `Workspace '${workspaceId}' not found for trigger '${id}'`;
    await updateRunStatus("failed", { errorMessage: errorMsg });
    throw new Error(errorMsg);
  }
  const workspace = workspaceRecord[0];

  // 2. Get provider from agent
  const providerRecord = await db
    .select()
    .from(providerTable)
    .where(eq(providerTable.id, agent.providerId))
    .limit(1);

  if (providerRecord.length === 0) {
    const errorMsg = `Provider '${agent.providerId}' not found for agent`;
    await updateRunStatus("failed", { errorMessage: errorMsg });
    throw new Error(errorMsg);
  }
  const provider = providerRecord[0];

  // 4. Create model
  const [aiProvider, model] = createModel(provider as Provider, agent.modelId);

  // 5. Load tools
  const orgId = workspace.organizationId;
  const frontendUrl = process.env.FRONTEND_URL;
  const { tools, mcpClients } = await loadTools(
    agent,
    workspaceId,
    orgId,
    frontendUrl,
  );

  // 5b. Configure Search (if enabled)
  if (trigger.search) {
    Object.assign(tools, createSearchTools(provider as Provider, aiProvider));
  }

  // 6. Load skills
  const skills = await loadSkills(agent, workspaceId);

  // 7. Fetch user contexts (workspace owner is the "user" for triggered runs)
  const user = { id: workspace.ownerId, name: "Trigger User" };
  const { userGlobalContext, userWorkspaceContext } = await fetchUserContexts(
    workspace.ownerId,
    workspaceId,
  );

  // 8. Fetch memories
  const memoriesFormatted = await fetchFormattedMemories(
    workspace.ownerId,
    workspaceId,
  );

  // 9. Resolve generation config
  const config = await resolveGenerationConfig(
    {},
    workspaceId,
    agent,
    workspace.context || undefined,
    skills,
    user,
    userGlobalContext,
    userWorkspaceContext,
    undefined, // no sub-agents for triggered runs
    memoriesFormatted,
  );

  // 10. Prepare tools
  prepareAgentTools(tools, skills, workspaceId);

  // 11. Build the effective prompt
  let effectiveInstruction = instruction;
  if (eventContext) {
    effectiveInstruction = `Event: ${eventContext.eventType}\nEvent Data:\n${JSON.stringify(eventContext.eventData, null, 2)}\n---\n${instruction}`;
  }

  // 12. Execute agent with instruction
  const chatId = nanoid();
  const startTime = Date.now();

  try {
    logger.info(
      {
        triggerId: id,
        runId,
        chatId,
        agentId,
        type: trigger.type,
        instruction: effectiveInstruction.substring(0, 100) + "...",
      },
      "Starting trigger execution",
    );

    const result = await generateText({
      model: model as LanguageModel,
      prompt: effectiveInstruction,
      tools,
      system: config.systemPrompt,
      stopWhen: [stepCountIs(agent.maxSteps ?? 1)],
      ...Object.fromEntries(
        Object.entries({
          temperature: config.temperature,
          topP: config.topP,
          topK: config.topK,
          frequencyPenalty: config.frequencyPenalty,
          presencePenalty: config.presencePenalty,
        }).filter(([, v]) => v !== undefined),
      ),
    });

    const duration = Date.now() - startTime;

    // Build the chat messages from the result
    const messages: PlatypusUIMessage[] = [
      {
        id: nanoid(),
        role: "user",
        parts: [{ type: "text", text: effectiveInstruction }],
      },
      {
        id: nanoid(),
        role: "assistant",
        parts: [{ type: "text", text: result.text }],
      },
    ];

    // 13. Save chat record
    await db.insert(chatTable).values({
      id: chatId,
      workspaceId,
      title: `Triggered: ${trigger.name}`,
      messages,
      agentId: agent.id,
      triggerId: id,
      memoryExtractionStatus: "completed", // Skip memory extraction for triggered chats
      tags: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Update run status to success
    await updateRunStatus("success", { chatId });

    logger.info(
      {
        triggerId: id,
        runId,
        chatId,
        duration,
        responseLength: result.text.length,
      },
      "Trigger execution completed",
    );

    return chatId;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error(
      {
        error,
        triggerId: id,
        runId,
        chatId,
        duration: Date.now() - startTime,
      },
      "Trigger execution failed",
    );

    // Update run status to failed
    await updateRunStatus("failed", { errorMessage });

    throw error;
  } finally {
    // Close MCP clients
    for (const mcpClient of mcpClients) {
      try {
        await mcpClient.close();
      } catch (error) {
        logger.error({ error }, "Error closing MCP client");
      }
    }
  }
};

/**
 * Updates the trigger after execution:
 * - Sets lastRunAt
 * - For cron: computes nextRunAt, handles one-off disable
 * - For event: just updates lastRunAt
 * - Performs retention cleanup
 */
export const updateTriggerAfterRun = async (
  triggerId: string,
  trigger: typeof triggerTable.$inferSelect,
): Promise<void> => {
  const now = new Date();
  const { maxChatsToKeep, type, config } = trigger;

  let nextRunAt: Date | null = null;
  let enabled = true;

  if (type === "cron") {
    const cronConfig = config as CronTriggerConfig;
    if (cronConfig.isOneOff) {
      // One-off triggers are disabled after first run
      enabled = false;
    } else {
      nextRunAt = validateCronExpression(
        cronConfig.cronExpression,
        cronConfig.timezone,
      );
      if (!nextRunAt) {
        logger.error(
          { triggerId, cronExpression: cronConfig.cronExpression },
          "Failed to compute next run for trigger",
        );
      }
    }
  }
  // For event triggers, nextRunAt stays null and enabled stays true

  // Update the trigger
  await db
    .update(triggerTable)
    .set({
      lastRunAt: now,
      nextRunAt,
      enabled,
      updatedAt: now,
    })
    .where(eq(triggerTable.id, triggerId));

  // Retention cleanup: delete old chats and runs beyond maxChatsToKeep (in parallel)
  if (maxChatsToKeep > 0) {
    await Promise.all([
      retainNewest(
        chatTable,
        chatTable.triggerId,
        chatTable.id,
        chatTable.createdAt,
        triggerId,
        maxChatsToKeep,
        "trigger chats",
      ),
      retainNewest(
        triggerRunTable,
        triggerRunTable.triggerId,
        triggerRunTable.id,
        triggerRunTable.startedAt,
        triggerId,
        maxChatsToKeep,
        "trigger runs",
      ),
    ]);
  }

  logger.info(
    {
      triggerId,
      type,
      enabled,
      nextRunAt: nextRunAt?.toISOString(),
    },
    "Updated trigger after run",
  );
};
