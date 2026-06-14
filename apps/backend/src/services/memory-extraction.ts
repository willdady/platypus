import { generateText } from "ai";
import { eq, and, or, isNull, sql, inArray, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  chat as chatTable,
  memoryDailySummary as memoryDailySummaryTable,
  workspace as workspaceTable,
  provider as providerTable,
} from "../db/schema.ts";
import type { Provider } from "@platypus/schemas";
import { logger } from "../logger.ts";
import type { PlatypusUIMessage } from "../types.ts";
import { openProvider } from "./provider.ts";
import { generateEmbedding } from "./embedding.ts";

/**
 * Formats conversation messages for the summary prompt.
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
 * Builds the summary prompt for the LLM.
 */
const buildSummaryPrompt = (
  conversationText: string,
  existingSummary: string | null,
): string => {
  return `You are a memory consolidation assistant. You maintain a daily summary of what is known about the user from their conversations.

<existing-summary>
${existingSummary || "No summary yet."}
</existing-summary>

<conversation>
${conversationText}
</conversation>

<instructions>
- Produce an updated daily summary incorporating any new information from the conversation
- Use a compact markdown format with bulleted lists under topic headings
- Write in third person (about the user)
- Preserve specific details (names, numbers, preferences) — do not generalize
- If the conversation contradicts something in the existing summary, update it
- If the user asks to forget something, remove it from the summary
- If the conversation reveals nothing worth remembering, return the existing summary unchanged
- Aim for 100-500 words total
- Return ONLY the updated summary text, no preamble or explanation
</instructions>`;
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
 * Gets today's date string in YYYY-MM-DD format.
 */
const getTodayDateString = (): string => {
  return new Date().toISOString().split("T")[0];
};

/**
 * Processes a single chat for memory extraction into daily summaries.
 */
const processChat = async (
  chat: typeof chatTable.$inferSelect,
  workspace: typeof workspaceTable.$inferSelect,
  extractionProvider: typeof providerTable.$inferSelect,
  embeddingProvider: typeof providerTable.$inferSelect | null,
): Promise<void> => {
  const messages = (chat.messages as PlatypusUIMessage[]) || [];

  // Only process chats with at least 2 messages (user + assistant)
  if (messages.length < 2) {
    logger.debug(`Chat ${chat.id} has insufficient messages, skipping`);
    await updateChatExtractionStatus(chat.id, "completed");
    return;
  }

  const userId = workspace.ownerId;
  const todayDate = getTodayDateString();

  // Load today's existing summary for this user+workspace
  const [existingSummaryRow] = await db
    .select()
    .from(memoryDailySummaryTable)
    .where(
      and(
        eq(memoryDailySummaryTable.userId, userId),
        eq(memoryDailySummaryTable.workspaceId, workspace.id),
        eq(memoryDailySummaryTable.summaryDate, todayDate),
      ),
    )
    .limit(1);

  const existingSummary = existingSummaryRow?.summary || null;

  // Format conversation and build prompt
  const conversationText = formatConversation(messages);
  const summaryPrompt = buildSummaryPrompt(conversationText, existingSummary);

  logger.debug(
    {
      chatId: chat.id,
      messageCount: messages.length,
      hasExistingSummary: !!existingSummary,
      modelId: extractionProvider.memoryExtractionModelId,
      promptLength: summaryPrompt.length,
    },
    "Running memory summary extraction",
  );

  // Create the model
  const model = openProvider(extractionProvider as Provider).languageModel(
    extractionProvider.memoryExtractionModelId,
  );

  // Call the LLM for summary generation
  let result;
  try {
    result = await generateText({
      model,
      prompt: summaryPrompt,
      temperature: 0.3,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      {
        err: error,
        chatId: chat.id,
        modelId: extractionProvider.memoryExtractionModelId,
      },
      `Memory summary extraction LLM call failed: ${message}`,
    );
    await updateChatExtractionStatus(chat.id, "failed");
    return;
  }

  const updatedSummary = result.text.trim();

  if (!updatedSummary) {
    logger.warn(`Empty summary returned for chat ${chat.id}, skipping`);
    await updateChatExtractionStatus(chat.id, "completed");
    return;
  }

  // Generate embedding if embedding provider is configured
  let embedding: number[] | null = null;
  if (embeddingProvider && embeddingProvider.embeddingModelId) {
    try {
      embedding = await generateEmbedding(
        embeddingProvider as Provider,
        embeddingProvider.embeddingModelId,
        updatedSummary,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { err: error, chatId: chat.id },
        `Failed to generate embedding for daily summary: ${message}`,
      );
    }
  }

  // Upsert the daily summary
  const now = new Date();
  if (existingSummaryRow) {
    await db
      .update(memoryDailySummaryTable)
      .set({
        summary: updatedSummary,
        embedding,
        updatedAt: now,
      })
      .where(eq(memoryDailySummaryTable.id, existingSummaryRow.id));

    logger.info(
      `Updated daily summary for chat ${chat.id} (date: ${todayDate})`,
    );
  } else {
    await db.insert(memoryDailySummaryTable).values({
      id: nanoid(),
      userId,
      workspaceId: workspace.id,
      summaryDate: todayDate,
      summary: updatedSummary,
      embedding,
      createdAt: now,
      updatedAt: now,
    });

    logger.info(
      `Created daily summary for chat ${chat.id} (date: ${todayDate})`,
    );
  }

  // Prune old summaries exceeding maxDailySummaries
  const maxSummaries = workspace.maxDailySummaries ?? 90;
  const pruneResult = await db.execute(sql`
    DELETE FROM memory_daily_summary
    WHERE id IN (
      SELECT id FROM memory_daily_summary
      WHERE user_id = ${userId} AND workspace_id = ${workspace.id}
      ORDER BY summary_date DESC
      OFFSET ${maxSummaries}
    )
  `);

  if (pruneResult.rowCount && pruneResult.rowCount > 0) {
    logger.info(
      `Pruned ${pruneResult.rowCount} old daily summaries for user ${userId} in workspace ${workspace.id}`,
    );
  }

  // Mark chat as processed
  await updateChatExtractionStatus(chat.id, "completed");

  logger.info(`Memory summary extraction completed for chat ${chat.id}`);
};

/**
 * Finds chats that need memory extraction processing.
 */
const findChatsToProcess = async (): Promise<
  Array<{
    chat: typeof chatTable.$inferSelect;
    workspace: typeof workspaceTable.$inferSelect;
    extractionProvider: typeof providerTable.$inferSelect;
    embeddingProvider: typeof providerTable.$inferSelect | null;
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
    .limit(50);

  // Collect all provider IDs needed (extraction + embedding)
  const providerIds = new Set<string>();
  for (const w of workspacesWithExtraction) {
    if (w.memoryExtractionProviderId)
      providerIds.add(w.memoryExtractionProviderId);
    if (w.memoryEmbeddingProviderId)
      providerIds.add(w.memoryEmbeddingProviderId);
  }

  const providers =
    providerIds.size > 0
      ? await db
          .select()
          .from(providerTable)
          .where(inArray(providerTable.id, [...providerIds]))
      : [];

  const providerMap = new Map(providers.map((p) => [p.id, p]));
  const workspaceMap = new Map(workspacesWithExtraction.map((w) => [w.id, w]));

  // Build result with all required data
  const result: Array<{
    chat: typeof chatTable.$inferSelect;
    workspace: typeof workspaceTable.$inferSelect;
    extractionProvider: typeof providerTable.$inferSelect;
    embeddingProvider: typeof providerTable.$inferSelect | null;
  }> = [];

  for (const { chat } of chatsToProcess) {
    const workspace = workspaceMap.get(chat.workspaceId);
    if (!workspace || !workspace.memoryExtractionProviderId) continue;

    const extractionProvider = providerMap.get(
      workspace.memoryExtractionProviderId,
    );
    if (!extractionProvider) continue;

    const embeddingProvider = workspace.memoryEmbeddingProviderId
      ? (providerMap.get(workspace.memoryEmbeddingProviderId) ?? null)
      : null;

    result.push({ chat, workspace, extractionProvider, embeddingProvider });
  }

  return result;
};

/**
 * Processes a batch of chats for memory extraction.
 * This is the main entry point called by the memory scheduler.
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
    for (const {
      chat,
      workspace,
      extractionProvider,
      embeddingProvider,
    } of chatsToProcess) {
      try {
        // Mark as processing
        await updateChatExtractionStatus(chat.id, "processing");

        // Process the chat
        await processChat(
          chat,
          workspace,
          extractionProvider,
          embeddingProvider,
        );
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
