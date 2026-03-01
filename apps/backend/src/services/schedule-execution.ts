import { nanoid } from "nanoid";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { generateText, stepCountIs, type LanguageModelV1 } from "ai";
import { db } from "../index.ts";
import {
  schedule as scheduleTable,
  scheduleRun as scheduleRunTable,
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
} from "./chat-execution.ts";
import { logger } from "../logger.ts";
import { validateCronExpression } from "../utils/cron.ts";
import type { PlatypusUIMessage } from "../types.ts";
import type { Provider } from "@platypus/schemas";

/**
 * Executes a schedule by running the agent with the configured instruction.
 * Returns the created chat ID.
 */
export const triggerSchedule = async (
  schedule: typeof scheduleTable.$inferSelect,
): Promise<string> => {
  const { id, workspaceId, agentId, instruction } = schedule;

  // Create a schedule run record
  const runId = nanoid();
  await db.insert(scheduleRunTable).values({
    id: runId,
    scheduleId: id,
    status: "pending",
    startedAt: new Date(),
    createdAt: new Date(),
  });

  // Helper to update run status
  const updateRunStatus = async (
    status: "running" | "success" | "failed",
    data?: { chatId?: string; errorMessage?: string },
  ) => {
    await db
      .update(scheduleRunTable)
      .set({
        status,
        chatId: data?.chatId ?? null,
        errorMessage: data?.errorMessage ?? null,
        completedAt:
          status === "success" || status === "failed" ? new Date() : null,
      })
      .where(eq(scheduleRunTable.id, runId));
  };

  // 1. Fetch the agent
  const agentRecord = await db
    .select()
    .from(agentTable)
    .where(eq(agentTable.id, agentId))
    .limit(1);

  if (agentRecord.length === 0) {
    const errorMsg = `Agent '${agentId}' not found for schedule '${id}'`;
    await updateRunStatus("failed", { errorMessage: errorMsg });
    throw new Error(errorMsg);
  }
  const agent = agentRecord[0];

  // 2. Fetch the workspace to get owner info
  const workspaceRecord = await db
    .select()
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);

  if (workspaceRecord.length === 0) {
    const errorMsg = `Workspace '${workspaceId}' not found for schedule '${id}'`;
    await updateRunStatus("failed", { errorMessage: errorMsg });
    throw new Error(errorMsg);
  }
  const workspace = workspaceRecord[0];

  // 3. Get provider from agent
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
  const [, model] = createModel(provider as Provider, agent.modelId);

  // 5. Load tools
  const { tools, mcpClients } = await loadTools(agent, workspaceId);

  // 6. Load skills
  const skills = await loadSkills(agent, workspaceId);

  // 7. Fetch user contexts (workspace owner is the "user" for scheduled runs)
  const user = { id: workspace.ownerId, name: "Schedule User" };
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
    undefined, // no sub-agents for scheduled runs
    memoriesFormatted,
  );

  // 10. Prepare tools
  prepareAgentTools(tools, skills, workspaceId);

  // 11. Execute agent with instruction
  const chatId = nanoid();
  const startTime = Date.now();

  // Mark as running
  await updateRunStatus("running");

  try {
    logger.info(
      {
        scheduleId: id,
        runId,
        chatId,
        agentId,
        instruction: instruction.substring(0, 100) + "...",
      },
      "Starting schedule execution",
    );

    const result = await generateText({
      model: model as LanguageModelV1,
      prompt: instruction,
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
        parts: [{ type: "text", text: instruction }],
      },
      {
        id: nanoid(),
        role: "assistant",
        parts: [{ type: "text", text: result.text }],
      },
    ];

    // 12. Save chat record
    await db.insert(chatTable).values({
      id: chatId,
      workspaceId,
      title: `Scheduled: ${schedule.name}`,
      messages,
      agentId: agent.id,
      scheduleId: id,
      memoryExtractionStatus: "completed", // Skip memory extraction for scheduled chats
      tags: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Update run status to success
    await updateRunStatus("success", { chatId });

    logger.info(
      {
        scheduleId: id,
        runId,
        chatId,
        duration,
        responseLength: result.text.length,
      },
      "Schedule execution completed",
    );

    return chatId;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error(
      {
        error,
        scheduleId: id,
        runId,
        chatId,
        duration: Date.now() - startTime,
      },
      "Schedule execution failed",
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
 * Updates the schedule after execution:
 * - Sets lastRunAt
 * - Computes nextRunAt
 * - If one-off, disables the schedule
 * - Performs retention cleanup
 */
export const updateScheduleAfterRun = async (
  scheduleId: string,
  maxChatsToKeep: number,
  isOneOff: boolean,
  cronExpression: string,
  timezone: string,
): Promise<void> => {
  const now = new Date();

  // Compute next run
  let nextRunAt: Date | null = null;
  let enabled = true;

  if (isOneOff) {
    // One-off schedules are disabled after first run
    enabled = false;
  } else {
    nextRunAt = validateCronExpression(cronExpression, timezone);
    if (!nextRunAt) {
      logger.error(
        { scheduleId, cronExpression },
        "Failed to compute next run for schedule",
      );
    }
  }

  // Update the schedule
  await db
    .update(scheduleTable)
    .set({
      lastRunAt: now,
      nextRunAt,
      enabled,
      updatedAt: now,
    })
    .where(eq(scheduleTable.id, scheduleId));

  // Retention cleanup: delete old chats beyond maxChatsToKeep
  if (maxChatsToKeep > 0) {
    const chatsToKeep = await db
      .select({ id: chatTable.id })
      .from(chatTable)
      .where(eq(chatTable.scheduleId, scheduleId))
      .orderBy(desc(chatTable.createdAt))
      .limit(maxChatsToKeep);

    if (chatsToKeep.length === maxChatsToKeep) {
      const idsToKeep = chatsToKeep.map((c) => c.id);

      const deleted = await db
        .delete(chatTable)
        .where(
          and(
            eq(chatTable.scheduleId, scheduleId),
            notInArray(chatTable.id, idsToKeep),
          ),
        )
        .returning({ id: chatTable.id });

      if (deleted.length > 0) {
        logger.info(
          {
            scheduleId,
            deletedCount: deleted.length,
            maxChatsToKeep,
          },
          "Cleaned up old schedule chats",
        );
      }
    }

    // Retention cleanup: delete old runs beyond maxChatsToKeep
    const runsToKeep = await db
      .select({ id: scheduleRunTable.id })
      .from(scheduleRunTable)
      .where(eq(scheduleRunTable.scheduleId, scheduleId))
      .orderBy(desc(scheduleRunTable.startedAt))
      .limit(maxChatsToKeep);

    if (runsToKeep.length === maxChatsToKeep) {
      const runIdsToKeep = runsToKeep.map((r) => r.id);

      const deletedRuns = await db
        .delete(scheduleRunTable)
        .where(
          and(
            eq(scheduleRunTable.scheduleId, scheduleId),
            notInArray(scheduleRunTable.id, runIdsToKeep),
          ),
        )
        .returning({ id: scheduleRunTable.id });

      if (deletedRuns.length > 0) {
        logger.info(
          {
            scheduleId,
            deletedCount: deletedRuns.length,
            maxChatsToKeep,
          },
          "Cleaned up old schedule runs",
        );
      }
    }
  }

  logger.info(
    {
      scheduleId,
      isOneOff,
      enabled,
      nextRunAt: nextRunAt?.toISOString(),
    },
    "Updated schedule after run",
  );
};
