import { generateText, Output } from "ai";
import { eq, and, or, isNull, sql, inArray, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  retrieveUserLevelMemories,
  retrieveWorkspaceLevelMemories,
  formatMemoriesForPrompt,
} from "./memory-retrieval.ts";
import {
  chat as chatTable,
  memory as memoryTable,
  workspace as workspaceTable,
  provider as providerTable,
} from "../db/schema.ts";
import { memoryExtractionOutputSchema, type Provider } from "@platypus/schemas";
import { logger } from "../logger.ts";
import type { PlatypusUIMessage } from "../types.ts";

// Import AI provider factories (same pattern as chat.ts)
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

/**
 * Creates a LanguageModel instance based on the provider configuration.
 * (Same pattern as in chat.ts)
 */
const createModel = (provider: Provider, modelId: string) => {
  if (provider.providerType === "OpenAI") {
    const openai = createOpenAI({
      baseURL: provider.baseUrl ?? undefined,
      apiKey: provider.apiKey ?? undefined,
      headers: provider.headers ?? undefined,
      organization: provider.organization ?? undefined,
      project: provider.project ?? undefined,
    });
    return openai(modelId);
  } else if (provider.providerType === "OpenRouter") {
    const openRouter = createOpenRouter({
      baseURL: provider.baseUrl ?? undefined,
      apiKey: provider.apiKey ?? undefined,
      headers: provider.headers ?? undefined,
      extraBody: provider.extraBody ?? undefined,
    });
    return openRouter(modelId);
  } else if (provider.providerType === "Bedrock") {
    const bedrock = createAmazonBedrock({
      baseURL: provider.baseUrl ?? undefined,
      region: provider.region ?? undefined,
      apiKey: provider.apiKey ?? undefined,
      headers: provider.headers ?? undefined,
    });
    return bedrock(modelId);
  } else if (provider.providerType === "Google") {
    const google = createGoogleGenerativeAI({
      baseURL: provider.baseUrl ?? undefined,
      apiKey: provider.apiKey ?? undefined,
      headers: provider.headers ?? undefined,
    });
    return google(modelId);
  } else if (provider.providerType === "Anthropic") {
    const anthropic = createAnthropic({
      baseURL: provider.baseUrl ?? undefined,
      apiKey: provider.apiKey ?? undefined,
      headers: provider.headers ?? undefined,
    });
    return anthropic(modelId);
  } else {
    throw new Error(`Unrecognized provider type '${provider.providerType}'`);
  }
};

/**
 * Formats conversation messages for the extraction prompt.
 */
const formatConversation = (messages: PlatypusUIMessage[]): string => {
  return messages
    .map((m) => {
      const textParts = m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      return `${m.role}: ${textParts}`;
    })
    .join("\n\n");
};

/**
 * Builds the extraction prompt for the LLM.
 */
const buildExtractionPrompt = (
  conversationText: string,
  existingMemoriesFormatted: string,
): string => {
  return `You are a memory extraction assistant. Analyze the conversation and extract persistent facts about the user that should be remembered for future conversations.

The user's existing memories are provided below in newline-delimited JSON format. You MUST:
- NOT re-extract information that already exists in the current memories
- If a conversation reveals updated information that contradicts an existing memory, include the existing memory's ID in the "updates" array with the corrected observation
- If the conversation explicitly indicates that an existing memory is wrong or no longer accurate, include its ID in the "deletes" array
- If the user explicitly asks to forget or remove something, include its ID in the "deletes" array
- Only return genuinely NEW information not covered by existing memories

Existing memories (NDJSON format):
${existingMemoriesFormatted}

Entity types: "preference", "fact", "goal", "constraint", "style", "person"

Scope determination:
- "user": Personal facts, general preferences, identity (applies across all of this user's workspaces)
- "workspace": Project-specific context, workspace-specific preferences (applies only in this workspace for this user)

Conversation:
${conversationText}`;
};

/**
 * Updates the chat's memory extraction status.
 */
const updateChatExtractionStatus = async (
  chatId: string,
  status: "pending" | "processing" | "completed" | "failed",
  processedAt?: Date,
) => {
  await db
    .update(chatTable)
    .set({
      memoryExtractionStatus: status,
      lastMemoryProcessedAt: processedAt || new Date(),
      updatedAt: new Date(),
    })
    .where(eq(chatTable.id, chatId));
};

/**
 * Processes a single chat for memory extraction.
 */
const processChat = async (
  chat: typeof chatTable.$inferSelect,
  workspace: typeof workspaceTable.$inferSelect,
  provider: typeof providerTable.$inferSelect,
): Promise<void> => {
  const messages = (chat.messages as PlatypusUIMessage[]) || [];

  // Only process chats with at least 2 messages (user + assistant)
  if (messages.length < 2) {
    logger.debug(`Chat ${chat.id} has insufficient messages, skipping`);
    await updateChatExtractionStatus(chat.id, "completed");
    return;
  }

  // Get the workspace owner (the user who owns the memories)
  const userId = workspace.ownerId;

  // Load existing memories (both user-level and workspace-level)
  const [userLevel, workspaceLevel] = await Promise.all([
    retrieveUserLevelMemories(userId),
    retrieveWorkspaceLevelMemories(userId, workspace.id),
  ]);
  const existingMemories = [...userLevel, ...workspaceLevel];

  // Format for the prompt
  const conversationText = formatConversation(messages);
  const existingMemoriesFormatted = formatMemoriesForPrompt(existingMemories);

  // Build the extraction prompt
  const extractionPrompt = buildExtractionPrompt(
    conversationText,
    existingMemoriesFormatted,
  );

  logger.debug(
    {
      chatId: chat.id,
      messageCount: messages.length,
      existingMemoryCount: existingMemories.length,
      modelId: provider.memoryExtractionModelId,
      promptLength: extractionPrompt.length,
    },
    "Running memory extraction",
  );

  // Create the model
  const model = createModel(
    provider as Provider,
    provider.memoryExtractionModelId,
  );

  // Call the LLM for extraction
  let result;
  try {
    result = await generateText({
      model,
      prompt: extractionPrompt,
      output: Output.object({
        schema: memoryExtractionOutputSchema,
      }),
      temperature: 0.3,
    });
  } catch (error: any) {
    logger.error(
      { error, chatId: chat.id, modelId: provider.memoryExtractionModelId },
      "Memory extraction LLM call failed",
    );
    await updateChatExtractionStatus(chat.id, "failed");
    return;
  }

  const { new: newMemories, updates, deletes } = result.output;

  // Insert new memories
  if (newMemories.length > 0) {
    const now = new Date();
    await db.insert(memoryTable).values(
      newMemories.map((m) => ({
        id: nanoid(),
        userId,
        workspaceId: m.scope === "workspace" ? workspace.id : null,
        chatId: chat.id,
        entityType: m.entityType,
        entityName: m.entityName,
        observation: m.observation,
        createdAt: now,
        updatedAt: now,
      })),
    );

    logger.info(
      `Inserted ${newMemories.length} new memories for chat ${chat.id}`,
    );
  }

  // Update existing memories
  if (updates.length > 0) {
    for (const update of updates) {
      // Verify the memory belongs to this user/workspace before updating
      const [existingMemory] = await db
        .select()
        .from(memoryTable)
        .where(
          and(eq(memoryTable.id, update.id), eq(memoryTable.userId, userId)),
        )
        .limit(1);

      if (existingMemory) {
        await db
          .update(memoryTable)
          .set({
            observation: update.observation,
            updatedAt: new Date(),
          })
          .where(eq(memoryTable.id, update.id));

        logger.info(`Updated memory ${update.id} for chat ${chat.id}`);
      } else {
        logger.warn(
          `Attempted to update memory ${update.id} that doesn't exist or doesn't belong to user ${userId}`,
        );
      }
    }
  }

  // Delete memories that are no longer relevant
  if (deletes.length > 0) {
    for (const deleteId of deletes) {
      // Verify the memory belongs to this user before deleting
      const [existingMemory] = await db
        .select()
        .from(memoryTable)
        .where(
          and(eq(memoryTable.id, deleteId), eq(memoryTable.userId, userId)),
        )
        .limit(1);

      if (existingMemory) {
        await db.delete(memoryTable).where(eq(memoryTable.id, deleteId));

        logger.info(`Deleted memory ${deleteId} for chat ${chat.id}`);
      } else {
        logger.warn(
          `Attempted to delete memory ${deleteId} that doesn't exist or doesn't belong to user ${userId}`,
        );
      }
    }
  }

  // Mark chat as processed
  await updateChatExtractionStatus(chat.id, "completed");

  logger.info(
    `Memory extraction completed for chat ${chat.id}: ${newMemories.length} new, ${updates.length} updated, ${deletes.length} deleted`,
  );
};

/**
 * Finds chats that need memory extraction processing.
 */
const findChatsToProcess = async (): Promise<
  Array<{
    chat: typeof chatTable.$inferSelect;
    workspace: typeof workspaceTable.$inferSelect;
    provider: typeof providerTable.$inferSelect;
  }>
> => {
  // Find workspaces with memory extraction enabled
  const workspacesWithExtraction = await db
    .select()
    .from(workspaceTable)
    .where(sql`${workspaceTable.memoryExtractionProviderId} IS NOT NULL`);

  if (workspacesWithExtraction.length === 0) {
    logger.debug("No workspaces have memory extraction enabled, skipping");
    return [];
  }

  const workspaceIds = workspacesWithExtraction.map((w) => w.id);

  // Find chats in those workspaces that need processing
  // Status is "pending" OR (status is "failed" AND last processed > 1 hour ago) OR never processed
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const chatsToProcess = await db
    .select({
      chat: chatTable,
    })
    .from(chatTable)
    .where(
      and(
        inArray(chatTable.workspaceId, workspaceIds),
        or(
          eq(chatTable.memoryExtractionStatus, "pending"),
          and(
            eq(chatTable.memoryExtractionStatus, "failed"),
            sql`${chatTable.lastMemoryProcessedAt} < ${oneHourAgo}`,
          ),
          isNull(chatTable.memoryExtractionStatus),
        ),
      ),
    )
    .orderBy(desc(chatTable.updatedAt))
    .limit(50); // Process up to 50 chats per batch

  // Fetch providers for each workspace
  const providerIds = workspacesWithExtraction
    .map((w) => w.memoryExtractionProviderId)
    .filter(Boolean) as string[];

  const providers = await db
    .select()
    .from(providerTable)
    .where(inArray(providerTable.id, providerIds));

  const providerMap = new Map(providers.map((p) => [p.id, p]));
  const workspaceMap = new Map(workspacesWithExtraction.map((w) => [w.id, w]));

  // Build result with all required data
  const result: Array<{
    chat: typeof chatTable.$inferSelect;
    workspace: typeof workspaceTable.$inferSelect;
    provider: typeof providerTable.$inferSelect;
  }> = [];

  for (const { chat } of chatsToProcess) {
    const workspace = workspaceMap.get(chat.workspaceId);
    if (!workspace || !workspace.memoryExtractionProviderId) continue;

    const provider = providerMap.get(workspace.memoryExtractionProviderId);
    if (!provider) continue;

    result.push({ chat, workspace, provider });
  }

  return result;
};

/**
 * Processes a batch of chats for memory extraction.
 * This is the main entry point called by the scheduler.
 */
export const processMemoryExtractionBatch = async (): Promise<void> => {
  logger.info("Starting memory extraction batch");

  try {
    const chatsToProcess = await findChatsToProcess();

    if (chatsToProcess.length === 0) {
      logger.info("No chats to process for memory extraction");
      return;
    }

    logger.info(`Found ${chatsToProcess.length} chats to process`);

    // Process chats sequentially to avoid rate limits and race conditions
    for (const { chat, workspace, provider } of chatsToProcess) {
      try {
        // Mark as processing
        await updateChatExtractionStatus(chat.id, "processing");

        // Process the chat
        await processChat(chat, workspace, provider);
      } catch (error) {
        logger.error(
          { error, chatId: chat.id },
          "Error processing chat for memory extraction",
        );
        await updateChatExtractionStatus(chat.id, "failed");
      }
    }

    logger.info("Memory extraction batch completed");
  } catch (error) {
    logger.error({ error }, "Error in memory extraction batch");
    throw error;
  }
};
