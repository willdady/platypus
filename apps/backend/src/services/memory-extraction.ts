import { generateText } from "ai";
import {
  eq,
  ne,
  lt,
  and,
  or,
  isNotNull,
  isNull,
  sql,
  inArray,
  desc,
} from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import type { provider as providerTable } from "../db/schema.ts";
import {
  a2aEndpoint as a2aEndpointTable,
  chat as chatTable,
  memoryDailySummary as memoryDailySummaryTable,
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { logger } from "../logger.ts";
import type { PlatypusUIMessage } from "../types.ts";
import { openProvider } from "./provider.ts";
import { jobCallSettings, jobMaxOutputTokens } from "./reasoning.ts";
import { CHARS_PER_TOKEN, jobInputBudgetChars } from "./job-input-budget.ts";
import {
  contextWindowForModel,
  pointerSettingModelId,
} from "./model-capability.ts";
import { generateEmbedding } from "./embedding.ts";
import { resolveScoped } from "./scoped-resource.ts";
import { loadActivePath } from "./chat-messages.ts";
import { errorMessage } from "../utils/error-message.ts";
import { withDeadline } from "../utils/abort-race.ts";

const DEFAULT_BUDGET_TOKENS = 32_000;
const CONTEXT_SHARE = 0.25;

export const SUMMARY_TIMEOUT_MS = 120_000;
const SUMMARY_MAX_OUTPUT_TOKENS = 8_192;
const SUMMARY_MAX_RETRIES = 1;

export const BATCH_DEADLINE_MS = 10 * 60_000;

const SEPARATOR = "\n\n";
const TRUNCATED = " [truncated]";

const formatMessage = (m: PlatypusUIMessage): string =>
  `${m.role}: ${m.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("")}`;

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

const buildSummaryPrompt = (
  existingSummary: string | null,
  contextText: string,
  newText: string,
): string => {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty summary gets the placeholder too
  const summary = existingSummary || "No summary yet.";
  return `You are a memory consolidation assistant. You maintain a daily summary of what is known about the user from their conversations.

<existing-summary>
${summary}
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

const updateChatExtractionStatus = async (
  chatId: string,
  status: "processing" | "failed",
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

const completeChatExtraction = async (
  chatId: string,
  readAt: Date,
  cursor: string | null,
) => {
  await db
    .update(chatTable)
    .set({
      memoryExtractionStatus: "completed",
      lastMemoryProcessedAt: readAt,
      memoryCursorId: cursor,
      updatedAt: new Date(),
    })
    .where(eq(chatTable.id, chatId));
};

const getTodayDateString = (): string => {
  return new Date().toISOString().slice(0, 10);
};

const processChat = async (
  chat: ChatToProcess["chat"],
  workspace: typeof workspaceTable.$inferSelect,
  extractionProvider: typeof providerTable.$inferSelect,
  embeddingProvider: typeof providerTable.$inferSelect | null,
  readAt: Date,
): Promise<void> => {
  const failPass = (): Promise<void> =>
    updateChatExtractionStatus(chat.id, "failed", readAt);

  const { messages } = await loadActivePath(chat.id, chat.activeLeafId);

  let readCount = 0;
  if (chat.memoryCursorId) {
    readCount = messages.findIndex((m) => m.id === chat.memoryCursorId) + 1;
    if (readCount === 0) {
      const cursorPath = await loadActivePath(chat.id, chat.memoryCursorId);
      const readIds = new Set(cursorPath.messages.map((m) => m.id));
      readCount = messages.findLastIndex((m) => readIds.has(m.id)) + 1;
    }
  }
  const fresh = messages.slice(readCount);
  const [oldestFresh] = fresh;
  if (!oldestFresh) {
    await completeChatExtraction(chat.id, readAt, chat.activeLeafId);
    return;
  }

  const userId = workspace.ownerId;
  const todayDate = getTodayDateString();

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

  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty summary counts as none
  const existingSummary = existingSummaryRow?.summary || null;

  const modelId = pointerSettingModelId(
    extractionProvider.memoryExtractionModelId,
  );
  const maxOutputTokens = jobMaxOutputTokens(
    extractionProvider,
    modelId,
    extractionProvider.memoryExtractionModelSettings,
    SUMMARY_MAX_OUTPUT_TOKENS,
  );
  const contextWindow = contextWindowForModel(extractionProvider, modelId);
  const budgetChars =
    contextWindow !== undefined
      ? jobInputBudgetChars(contextWindow, maxOutputTokens)
      : DEFAULT_BUDGET_TOKENS * CHARS_PER_TOKEN;
  const fixedPromptChars = buildSummaryPrompt(existingSummary, "", "").length;
  const room = budgetChars - fixedPromptChars;

  if (contextWindow !== undefined && room <= 0) {
    logger.warn(
      {
        chatId: chat.id,
        modelId,
        contextWindow,
        maxOutputTokens,
        promptLength: fixedPromptChars,
      },
      "Memory extraction skipped: the model's context window leaves no room for input after its reply",
    );
    await failPass();
    return;
  }

  const freshLines = fresh.map(formatMessage);
  let included = countFitting(freshLines, room);
  let newText = freshLines.slice(0, included).join(SEPARATOR);
  if (included === 0) {
    included = 1;
    const line = formatMessage(oldestFresh);
    newText = line.slice(0, Math.max(0, room - TRUNCATED.length)) + TRUNCATED;
    logger.warn(
      {
        chatId: chat.id,
        messageId: oldestFresh.id,
        length: line.length,
        room,
      },
      "Memory extraction truncated a message larger than its budget",
    );
  }
  const lastIncluded = fresh[included - 1];
  if (!lastIncluded) throw new Error("Memory extraction included no message");
  const cursor = lastIncluded.id;

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

  const model = openProvider(extractionProvider, {
    sessionId: chat.id,
  }).languageModel(modelId);

  let result;
  try {
    result = await withDeadline(
      (abortSignal) =>
        generateText({
          model,
          prompt: summaryPrompt,
          ...jobCallSettings(
            extractionProvider,
            modelId,
            extractionProvider.memoryExtractionModelSettings,
            { temperature: 0.3 },
          ),
          maxOutputTokens,
          maxRetries: SUMMARY_MAX_RETRIES,
          abortSignal,
        }),
      SUMMARY_TIMEOUT_MS,
    );
  } catch (error) {
    const message = errorMessage(error);
    logger.error(
      {
        err: error,
        chatId: chat.id,
        modelId,
      },
      `Memory summary extraction LLM call failed: ${message}`,
    );
    await failPass();
    return;
  }

  const updatedSummary = result.text.trim();

  if (!updatedSummary) {
    logger.warn(`Empty summary returned for chat ${chat.id}`);
    await failPass();
    return;
  }

  let embedding: number[] | null = null;
  if (embeddingProvider && embeddingProvider.embeddingModelId) {
    try {
      embedding = await generateEmbedding(
        embeddingProvider,
        pointerSettingModelId(embeddingProvider.embeddingModelId),
        updatedSummary,
        chat.id,
      );
    } catch (error) {
      const message = errorMessage(error);
      logger.error(
        { err: error, chatId: chat.id },
        `Failed to generate embedding for daily summary: ${message}`,
      );
    }
  }

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

  const maxSummaries = workspace.maxDailySummaries;
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

  await completeChatExtraction(chat.id, readAt, cursor);

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

const findChatsToProcess = async (): Promise<ChatToProcess[]> => {
  const workspacesWithExtraction = await db
    .select()
    .from(workspaceTable)
    .where(isNotNull(workspaceTable.memoryExtractionProviderId));

  const workspaceMap = new Map<string, Omit<ChatToProcess, "chat">>();
  for (const workspace of workspacesWithExtraction) {
    const providerId = workspace.memoryExtractionProviderId;
    if (!providerId) {
      throw new Error(`Workspace '${workspace.id}' has no extraction Provider`);
    }
    const ctx = { orgId: workspace.organizationId, workspaceId: workspace.id };
    const extraction = await resolveScoped(db, "provider", providerId, ctx);
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
    return [];
  }

  const workspaceIds = [...workspaceMap.keys()];

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const chatsToProcess = await db
    .select({
      id: chatTable.id,
      workspaceId: chatTable.workspaceId,
      activeLeafId: chatTable.activeLeafId,
      memoryCursorId: chatTable.memoryCursorId,
    })
    .from(chatTable)
    .leftJoin(
      a2aEndpointTable,
      eq(a2aEndpointTable.id, chatTable.a2aEndpointId),
    )
    .leftJoin(triggerRunTable, eq(triggerRunTable.id, chatTable.triggerRunId))
    .leftJoin(triggerTable, eq(triggerTable.id, triggerRunTable.triggerId))
    .where(
      and(
        inArray(chatTable.workspaceId, workspaceIds),
        or(
          and(isNull(chatTable.a2aEndpointId), isNull(chatTable.triggerRunId)),
          eq(a2aEndpointTable.extractMemories, true),
          eq(triggerTable.extractMemories, true),
        ),
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

  return result;
};

export const processMemoryExtractionBatch = async (
  signal?: AbortSignal,
): Promise<void> => {
  logger.info("Starting memory extraction batch");
  const deadline = Date.now() + BATCH_DEADLINE_MS;

  try {
    const chatsToProcess = await findChatsToProcess();

    if (chatsToProcess.length === 0) {
      logger.info("No chats to process for memory extraction");
      return;
    }

    logger.info(`Found ${chatsToProcess.length} chats to process`);

    for (const {
      chat,
      workspace,
      extractionProvider,
      embeddingProvider,
    } of chatsToProcess) {
      if (signal?.aborted) {
        logger.info(
          "Memory extraction batch stopped for shutdown, before the next chat",
        );
        return;
      }
      if (Date.now() >= deadline) {
        logger.warn(
          "Memory extraction batch hit its deadline, before the next chat",
        );
        return;
      }
      const readAt = new Date();
      try {
        await updateChatExtractionStatus(chat.id, "processing", readAt);

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
