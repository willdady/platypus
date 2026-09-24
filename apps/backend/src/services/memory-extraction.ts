import { generateText } from "ai";
import {
  eq,
  ne,
  lt,
  and,
  or,
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
import {
  contextWindowForModel,
  pointerSettingModelId,
} from "./model-capability.ts";
import { generateEmbedding } from "./embedding.ts";
import { resolveScoped } from "./scoped-resource.ts";
import { loadActivePath } from "./chat-messages.ts";

/**
 * How much one pass may send, in tokens estimated as characters ÷ 4: half the
 * extraction model's context window, or 32k when it declares none. The context
 * gets at most a quarter of it, and only what the new messages leave.
 */
const BUDGET_SHARE = 0.5;
const DEFAULT_BUDGET_TOKENS = 32_000;
const CONTEXT_SHARE = 0.25;
const CHARS_PER_TOKEN = 4;

const SEPARATOR = "\n\n";
const TRUNCATED = " [truncated]";

/** One message as the summary prompt shows it: its text parts only. */
const formatMessage = (m: PlatypusUIMessage): string =>
  `${m.role}: ${m.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("")}`;

/** How many of `lines`, from the first, fit in `room` characters once joined. */
const countFitting = (lines: string[], room: number): number => {
  let used = 0;
  let count = 0;
  for (const line of lines) {
    used += (count ? SEPARATOR.length : 0) + line.length;
    if (used > room) break;
    count++;
  }
  return count;
};

/**
 * Builds the summary prompt for the LLM: the new messages to extract from, and
 * the earlier ones a previous pass already read, as context for them.
 */
const buildSummaryPrompt = (
  existingSummary: string | null,
  contextText: string,
  newText: string,
): string => {
  return `You are a memory consolidation assistant. You maintain a daily summary of what is known about the user from their conversations.

<existing-summary>
${existingSummary || "No summary yet."}
</existing-summary>

<context>
${contextText}
</context>

<new-messages>
${newText}
</new-messages>

<instructions>
- Produce an updated daily summary incorporating any new information from the new messages
- Add facts only from <new-messages>. <context> holds earlier messages from the same conversation that were already read: use it only to interpret the new messages, never as a source of facts
- Use a compact markdown format with bulleted lists under topic headings
- Write in third person (about the user)
- Preserve specific details (names, numbers, preferences) — do not generalize
- If the new messages contradict something in the existing summary, update it
- If the user asks to forget something, remove it from the summary
- If the new messages reveal nothing worth remembering, return the existing summary unchanged
- Aim for 100-500 words total
- Return ONLY the updated summary text, no preamble or explanation
</instructions>`;
};

/**
 * Updates the chat's memory extraction status. `readAt` is when the job read
 * the Chat, not when the pass finished; the failed-pass backoff counts from it.
 * `cursor` is passed only by a pass that succeeded, so a failed one leaves it
 * where it was and the retry covers the same messages.
 */
const updateChatExtractionStatus = async (
  chatId: string,
  status: "processing" | "completed" | "failed",
  readAt: Date,
  cursor?: string | null,
) => {
  await db
    .update(chatTable)
    .set({
      memoryExtractionStatus: status,
      lastMemoryProcessedAt: readAt,
      ...(cursor !== undefined && { memoryCursorId: cursor }),
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

  // Everything after the cursor is new; what a pass already read is context.
  let readCount = 0;
  if (chat.memoryCursorId) {
    readCount = messages.findIndex((m) => m.id === chat.memoryCursorId) + 1;
    if (readCount === 0) {
      // The cursor is off the Active path: the User moved to another
      // Alternative, or deleted it. The messages the two paths share were
      // read; everything after the deepest of them is new.
      const cursorPath = await loadActivePath(chat.id, chat.memoryCursorId);
      const readIds = new Set(cursorPath.messages.map((m) => m.id));
      readCount = messages.findLastIndex((m) => readIds.has(m.id)) + 1;
    }
  }
  const fresh = messages.slice(readCount);
  if (fresh.length === 0) {
    await updateChatExtractionStatus(
      chat.id,
      "completed",
      readAt,
      chat.activeLeafId,
    );
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

  const provider = extractionProvider as Provider;
  const modelId = pointerSettingModelId(
    extractionProvider.memoryExtractionModelId,
  );
  const contextWindow = contextWindowForModel(provider, modelId);
  const budgetChars =
    (contextWindow ? contextWindow * BUDGET_SHARE : DEFAULT_BUDGET_TOKENS) *
    CHARS_PER_TOKEN;
  const room = budgetChars - buildSummaryPrompt(existingSummary, "", "").length;

  // The new messages first, oldest first, as many as fit.
  const freshLines = fresh.map(formatMessage);
  let included = countFitting(freshLines, room);
  let newText = freshLines.slice(0, included).join(SEPARATOR);
  if (included === 0) {
    // One message larger than the whole budget: cut to fit, marked as cut, and
    // moved past like any other.
    included = 1;
    newText =
      freshLines[0].slice(0, Math.max(0, room - TRUNCATED.length)) + TRUNCATED;
    logger.warn(
      {
        chatId: chat.id,
        messageId: fresh[0].id,
        length: freshLines[0].length,
        room,
      },
      "Memory extraction truncated a message larger than its budget",
    );
  }
  const cursor = fresh[included - 1].id;

  // Then the most recent of what came before, in what is left.
  const contextLines = messages
    .slice(0, readCount)
    .map(formatMessage)
    .reverse();
  const contextText = contextLines
    .slice(
      0,
      countFitting(
        contextLines,
        Math.min(room - newText.length, budgetChars * CONTEXT_SHARE),
      ),
    )
    .reverse()
    .join(SEPARATOR);

  const summaryPrompt = buildSummaryPrompt(
    existingSummary,
    contextText,
    newText,
  );

  logger.debug(
    {
      chatId: chat.id,
      messageCount: included,
      hasExistingSummary: !!existingSummary,
      modelId,
      promptLength: summaryPrompt.length,
    },
    "Running memory summary extraction",
  );

  // Create the model
  const model = openProvider(provider).languageModel(modelId);

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
        modelId,
      },
      `Memory summary extraction LLM call failed: ${message}`,
    );
    await updateChatExtractionStatus(chat.id, "failed", readAt);
    return;
  }

  const updatedSummary = result.text.trim();

  // Not a pass that succeeded: a reply cut off before any text (a reasoning
  // model out of output tokens) would otherwise skip these messages for good.
  if (!updatedSummary) {
    logger.warn(`Empty summary returned for chat ${chat.id}`);
    await updateChatExtractionStatus(chat.id, "failed", readAt);
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
  await updateChatExtractionStatus(chat.id, "completed", readAt, cursor);

  logger.info(`Memory summary extraction completed for chat ${chat.id}`);
};

type ChatToProcess = {
  chat: Pick<
    typeof chatTable.$inferSelect,
    "id" | "workspaceId" | "activeLeafId" | "memoryCursorId"
  >;
  workspace: typeof workspaceTable.$inferSelect;
  extractionProvider: typeof providerTable.$inferSelect;
  embeddingProvider: typeof providerTable.$inferSelect | null;
};

/**
 * Finds chats that need memory extraction processing, and when they were read.
 *
 * A Chat is due when it is not mid-turn and its Active path ends somewhere its
 * cursor does not: a turn, an edit, a move to another Alternative or a
 * Delete. A Chat whose last pass failed waits an hour before its retry.
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
      memoryCursorId: chatTable.memoryCursorId,
    })
    .from(chatTable)
    .where(
      and(
        inArray(chatTable.workspaceId, workspaceIds),
        ne(chatTable.status, "running"),
        sql`${chatTable.activeLeafId} IS DISTINCT FROM ${chatTable.memoryCursorId}`,
        or(
          ne(chatTable.memoryExtractionStatus, "failed"),
          lt(chatTable.lastMemoryProcessedAt, oneHourAgo),
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
