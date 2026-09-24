import { generateText } from "ai";
import {
  eq,
  ne,
  gt,
  lt,
  and,
  or,
  isNull,
  isNotNull,
  sql,
  inArray,
  desc,
} from "drizzle-orm";
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
import { pointerSettingModelId } from "./model-capability.ts";
import { generateEmbedding } from "./embedding.ts";
import { resolveScoped } from "./scoped-resource.ts";
import { loadActivePath } from "./chat-messages.ts";

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
 * Updates the chat's memory extraction status. `readAt` is when the job read
 * the Chat's messages, not when the pass finished: a turn that starts mid-pass
 * lands after it, so the Chat is due again on a later run.
 */
const updateChatExtractionStatus = async (
  chatId: string,
  status: "processing" | "completed" | "failed",
  readAt: Date,
) => {
  await db
    .update(chatTable)
    .set({
      memoryExtractionStatus: status,
      lastMemoryProcessedAt: readAt,
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
  chat: ChatToProcess["chat"],
  workspace: typeof workspaceTable.$inferSelect,
  extractionProvider: typeof providerTable.$inferSelect,
  embeddingProvider: typeof providerTable.$inferSelect | null,
  readAt: Date,
): Promise<void> => {
  // The Active path only: an Alternative the User has moved away from is not
  // something they said.
  const { messages } = await loadActivePath(chat.id, chat.activeLeafId);

  // Only process chats with at least 2 messages (user + assistant)
  if (messages.length < 2) {
    logger.debug(`Chat ${chat.id} has insufficient messages, skipping`);
    await updateChatExtractionStatus(chat.id, "completed", readAt);
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
    pointerSettingModelId(extractionProvider.memoryExtractionModelId),
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
    await updateChatExtractionStatus(chat.id, "failed", readAt);
    return;
  }

  const updatedSummary = result.text.trim();

  if (!updatedSummary) {
    logger.warn(`Empty summary returned for chat ${chat.id}, skipping`);
    await updateChatExtractionStatus(chat.id, "completed", readAt);
    return;
  }

  // Generate embedding if embedding provider is configured
  let embedding: number[] | null = null;
  if (embeddingProvider && embeddingProvider.embeddingModelId) {
    try {
      embedding = await generateEmbedding(
        embeddingProvider as Provider,
        pointerSettingModelId(embeddingProvider.embeddingModelId),
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
  await updateChatExtractionStatus(chat.id, "completed", readAt);

  logger.info(`Memory summary extraction completed for chat ${chat.id}`);
};

type ChatToProcess = {
  chat: Pick<
    typeof chatTable.$inferSelect,
    "id" | "workspaceId" | "activeLeafId"
  >;
  workspace: typeof workspaceTable.$inferSelect;
  extractionProvider: typeof providerTable.$inferSelect;
  embeddingProvider: typeof providerTable.$inferSelect | null;
};

/**
 * Finds chats that need memory extraction processing, and when they were read.
 *
 * A Chat is due when it is not mid-turn and it has never been read, a turn
 * started after it was last read, or its last pass failed over an hour ago.
 * The turn signal is `lastTurnAt`, never `updatedAt`, which this job and
 * auto-titling bump themselves (see `db/schema.ts`).
 */
const findChatsToProcess = async (): Promise<{
  readAt: Date;
  chats: ChatToProcess[];
}> => {
  // Find workspaces with memory extraction enabled
  const workspacesWithExtraction = await db
    .select()
    .from(workspaceTable)
    .where(isNotNull(workspaceTable.memoryExtractionProviderId));

  // Resolved through the Scoped-resource authority, as every other resource a
  // Chat turn reaches is: a Shared Provider serves a Workspace's memory only
  // where an Attachment makes it visible there (ADR-0007). Resolved before the
  // Chat read, so a Workspace that cannot see its extraction Provider never
  // takes a slot in the batch.
  // ponytail: up to two lookups per memory-enabled Workspace each run; batch
  // the Provider and Attachment reads if that count grows large.
  const workspaceMap = new Map<string, Omit<ChatToProcess, "chat">>();
  for (const workspace of workspacesWithExtraction) {
    const ctx = { orgId: workspace.organizationId, workspaceId: workspace.id };
    const extraction = await resolveScoped(
      db,
      "provider",
      workspace.memoryExtractionProviderId!,
      ctx,
    );
    if (!extraction) {
      logger.warn(
        {
          workspaceId: workspace.id,
          providerId: workspace.memoryExtractionProviderId,
        },
        "Memory extraction skipped: provider is not visible in this workspace",
      );
      continue;
    }
    const embedding = workspace.memoryEmbeddingProviderId
      ? await resolveScoped(
          db,
          "provider",
          workspace.memoryEmbeddingProviderId,
          ctx,
        )
      : null;
    workspaceMap.set(workspace.id, {
      workspace,
      extractionProvider: extraction.row,
      embeddingProvider: embedding?.row ?? null,
    });
  }

  if (workspaceMap.size === 0) {
    logger.debug("No workspaces have memory extraction enabled, skipping");
    return { readAt: new Date(), chats: [] };
  }

  const workspaceIds = [...workspaceMap.keys()];

  // Find chats in those workspaces that need processing
  const readAt = new Date();
  const oneHourAgo = new Date(readAt.getTime() - 60 * 60 * 1000);

  // Not the messages: those are read per Chat as it is processed.
  const chatsToProcess = await db
    .select({
      id: chatTable.id,
      workspaceId: chatTable.workspaceId,
      activeLeafId: chatTable.activeLeafId,
    })
    .from(chatTable)
    .where(
      and(
        inArray(chatTable.workspaceId, workspaceIds),
        ne(chatTable.status, "running"),
        or(
          isNull(chatTable.lastMemoryProcessedAt),
          gt(chatTable.lastTurnAt, chatTable.lastMemoryProcessedAt),
          and(
            eq(chatTable.memoryExtractionStatus, "failed"),
            lt(chatTable.lastMemoryProcessedAt, oneHourAgo),
          ),
        ),
      ),
    )
    .orderBy(desc(chatTable.updatedAt))
    .limit(50);

  const result: ChatToProcess[] = [];
  for (const chat of chatsToProcess) {
    const resolved = workspaceMap.get(chat.workspaceId);
    if (resolved) result.push({ chat, ...resolved });
  }

  return { readAt, chats: result };
};

/**
 * Processes a batch of chats for memory extraction.
 * This is the main entry point called by the memory scheduler.
 */
export const processMemoryExtractionBatch = async (): Promise<void> => {
  logger.info("Starting memory extraction batch");

  try {
    const { readAt, chats: chatsToProcess } = await findChatsToProcess();

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
        await updateChatExtractionStatus(chat.id, "processing", readAt);

        // Process the chat
        await processChat(
          chat,
          workspace,
          extractionProvider,
          embeddingProvider,
          readAt,
        );
      } catch (error) {
        logger.error(
          { error, chatId: chat.id },
          "Error processing chat for memory extraction",
        );
        await updateChatExtractionStatus(chat.id, "failed", readAt);
      }
    }

    logger.info("Memory extraction batch completed");
  } catch (error) {
    logger.error({ error }, "Error in memory extraction batch");
    throw error;
  }
};
