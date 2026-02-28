import { nanoid } from "nanoid";
import { Cron } from "croner";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { generateText, stepCountIs } from "ai";
import { db } from "../index.ts";
import {
  cronJob as cronJobTable,
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
import type { PlatypusUIMessage } from "../types.ts";
import type { Provider } from "@platypus/schemas";

/**
 * Executes a cron job by running the agent with the configured instruction.
 * Returns the created chat ID.
 */
export const triggerCronJob = async (
  cronJob: typeof cronJobTable.$inferSelect,
): Promise<string> => {
  const { id, workspaceId, agentId, instruction } = cronJob;

  // 1. Fetch the agent
  const agentRecord = await db
    .select()
    .from(agentTable)
    .where(eq(agentTable.id, agentId))
    .limit(1);

  if (agentRecord.length === 0) {
    throw new Error(`Agent '${agentId}' not found for cron job '${id}'`);
  }
  const agent = agentRecord[0];

  // 2. Fetch the workspace to get owner info
  const workspaceRecord = await db
    .select()
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);

  if (workspaceRecord.length === 0) {
    throw new Error(
      `Workspace '${workspaceId}' not found for cron job '${id}'`,
    );
  }
  const workspace = workspaceRecord[0];

  // 3. Get provider from agent
  const providerRecord = await db
    .select()
    .from(providerTable)
    .where(eq(providerTable.id, agent.providerId))
    .limit(1);

  if (providerRecord.length === 0) {
    throw new Error(`Provider '${agent.providerId}' not found for agent`);
  }
  const provider = providerRecord[0];

  // 4. Create model
  const [, model] = createModel(provider as Provider, agent.modelId);

  // 5. Load tools
  const { tools, mcpClients } = await loadTools(agent, workspaceId);

  // 6. Load skills
  const skills = await loadSkills(agent, workspaceId);

  // 7. Fetch user contexts (workspace owner is the "user" for cron)
  const user = { id: workspace.ownerId, name: "Cron User" };
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
    undefined, // no sub-agents for cron
    memoriesFormatted,
  );

  // 10. Prepare tools
  prepareAgentTools(tools, skills, workspaceId);

  // 11. Execute agent with instruction
  const chatId = nanoid();
  const startTime = Date.now();

  try {
    logger.info(
      {
        cronJobId: id,
        chatId,
        agentId,
        instruction: instruction.substring(0, 100) + "...",
      },
      "Starting cron job execution",
    );

    const result = await generateText({
      model: model as any,
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
      title: `Cron: ${cronJob.name}`,
      messages,
      agentId: agent.id,
      cronJobId: id,
      memoryExtractionStatus: "completed", // Skip memory extraction for cron chats
      tags: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    logger.info(
      {
        cronJobId: id,
        chatId,
        duration,
        responseLength: result.text.length,
      },
      "Cron job execution completed",
    );

    return chatId;
  } catch (error) {
    logger.error(
      {
        error,
        cronJobId: id,
        chatId,
        duration: Date.now() - startTime,
      },
      "Cron job execution failed",
    );
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
 * Updates the cron job after execution:
 * - Sets lastRunAt
 * - Computes nextRunAt
 * - If one-off, disables the job
 * - Performs retention cleanup
 */
export const updateCronJobAfterRun = async (
  cronJobId: string,
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
    // One-off jobs are disabled after first run
    enabled = false;
  } else {
    try {
      const cron = new Cron(cronExpression, { timezone });
      nextRunAt = cron.nextRun();
    } catch (error) {
      logger.error(
        { error, cronJobId, cronExpression },
        "Failed to compute next run for cron job",
      );
    }
  }

  // Update the cron job
  await db
    .update(cronJobTable)
    .set({
      lastRunAt: now,
      nextRunAt,
      enabled,
      updatedAt: now,
    })
    .where(eq(cronJobTable.id, cronJobId));

  // Retention cleanup: delete old chats beyond maxChatsToKeep
  if (maxChatsToKeep > 0) {
    const chatsToKeep = await db
      .select({ id: chatTable.id })
      .from(chatTable)
      .where(eq(chatTable.cronJobId, cronJobId))
      .orderBy(desc(chatTable.createdAt))
      .limit(maxChatsToKeep);

    if (chatsToKeep.length === maxChatsToKeep) {
      const idsToKeep = chatsToKeep.map((c) => c.id);

      const deleted = await db
        .delete(chatTable)
        .where(
          and(
            eq(chatTable.cronJobId, cronJobId),
            notInArray(chatTable.id, idsToKeep),
          ),
        )
        .returning({ id: chatTable.id });

      if (deleted.length > 0) {
        logger.info(
          {
            cronJobId,
            deletedCount: deleted.length,
            maxChatsToKeep,
          },
          "Cleaned up old cron job chats",
        );
      }
    }
  }

  logger.info(
    {
      cronJobId,
      isOneOff,
      enabled,
      nextRunAt: nextRunAt?.toISOString(),
    },
    "Updated cron job after run",
  );
};
