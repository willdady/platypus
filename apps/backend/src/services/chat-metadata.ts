import { generateText, Output } from "ai";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index.ts";
import {
  chat as chatTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { openProvider } from "./provider.ts";
import { pointerSettingModelId } from "./model-capability.ts";
import { jobCallSettings, jobMaxOutputTokens } from "./reasoning.ts";
import {
  drizzleTaskModelQueries,
  isChatsOwnModel,
  resolveTaskModelProvider,
} from "./task-model.ts";
import {
  UNTITLED_CHAT_TITLE,
  chatSchema,
  type ConcreteModelId,
} from "@platypus/schemas";
import type { PlatypusUIMessage } from "../types.ts";
import type { ProviderRow } from "./provider-write.ts";
import { logger } from "../logger.ts";
import { loadActivePath } from "./chat-messages.ts";
import { withDeadline } from "../utils/abort-race.ts";

const MAX_CONVERSATION_CHARS = 8_000;
const TITLE_TIMEOUT_MS = 30_000;
const TITLE_MAX_OUTPUT_TOKENS = 2_048;
const TITLE_MAX_RETRIES = 1;
export const MAX_TITLE_FAILURES = 3;

export type GenerateChatMetadataParams = {
  chatId: string;
  workspaceId: string;
  orgId: string;
  // why: the run's resolved provider; the chat row nulls its provider for agent runs
  providerId: string;
};

export type StartEarlyChatTitleParams = GenerateChatMetadataParams & {
  modelId: ConcreteModelId;
};

const hasUserText = (messages: PlatypusUIMessage[]): boolean =>
  messages.some(
    (m) =>
      m.role === "user" &&
      m.parts.some((p) => p.type === "text" && p.text.trim().length > 0),
  );

type TitleChat = {
  id: string;
  title: string;
  activeLeafId: string | null;
  titleFailures: number;
};

const readTitleChat = async (
  chatId: string,
  workspaceId: string,
): Promise<TitleChat | undefined> => {
  const rows = await db
    .select({
      id: chatTable.id,
      title: chatTable.title,
      activeLeafId: chatTable.activeLeafId,
      titleFailures: chatTable.titleFailures,
    })
    .from(chatTable)
    .where(
      and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
    )
    .limit(1);
  return rows[0];
};

type TitleProvider =
  | { status: "resolved"; provider: ProviderRow }
  | { status: "no-workspace" }
  | { status: "invisible"; providerId: string; fromOverride: boolean };

const readTitleProvider = async (
  params: GenerateChatMetadataParams,
): Promise<TitleProvider> => {
  const { workspaceId, orgId, providerId } = params;

  const workspaceRows = await db
    .select()
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);
  const workspace = workspaceRows[0];
  if (!workspace) return { status: "no-workspace" };

  const taskProvider = await resolveTaskModelProvider(
    {
      workspace,
      fallbackProviderId: providerId,
      orgId,
      workspaceId,
    },
    drizzleTaskModelQueries,
  );
  if (!taskProvider.provider) {
    return {
      status: "invisible",
      providerId: taskProvider.providerId,
      fromOverride: taskProvider.fromOverride,
    };
  }
  return { status: "resolved", provider: taskProvider.provider };
};

const titleChat = async (args: {
  chat: TitleChat;
  messages: PlatypusUIMessage[];
  provider: ProviderRow;
  workspaceId: string;
}): Promise<{ id: string; title: string } | null> => {
  const { chat, messages, provider, workspaceId } = args;
  const chatId = chat.id;

  const taskModelId = pointerSettingModelId(provider.taskModelId);
  const model = openProvider(provider, { sessionId: chatId }).languageModel(
    taskModelId,
  );

  const conversationText = messages
    .map((m) => {
      const message = m.parts.map((p) => {
        if (p.type === "text") return p.text;
        return "";
      });
      return `${m.role}:\n${message.join("")}`;
    })
    .join("\n")
    .slice(0, MAX_CONVERSATION_CHARS);

  const promptParts = [
    `Generate a short, descriptive title for this chat conversation. You MAY use at most one emoji. The complete title MUST NOT exceed 30 characters.`,
  ];

  promptParts.push(`Conversation:\n${conversationText}`);

  const recordFailure = async () => {
    const [counted] = await db
      .update(chatTable)
      .set({ titleFailures: sql`${chatTable.titleFailures} + 1` })
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.title, UNTITLED_CHAT_TITLE)),
      )
      .returning({ titleFailures: chatTable.titleFailures });
    if (counted?.titleFailures === MAX_TITLE_FAILURES) {
      logger.warn(
        { chatId, workspaceId, failures: MAX_TITLE_FAILURES },
        "Chat titling gave up: the chat stays Untitled until renamed",
      );
    }
  };

  let output: { title: string };
  try {
    ({ output } = await withDeadline(
      (abortSignal) =>
        generateText({
          model,
          output: Output.object({
            schema: z.object({
              title: z.string(),
            }),
          }),
          prompt: promptParts.join("\n"),
          ...jobCallSettings(provider, taskModelId, provider.taskModelSettings),
          maxOutputTokens: jobMaxOutputTokens(
            provider,
            taskModelId,
            provider.taskModelSettings,
            TITLE_MAX_OUTPUT_TOKENS,
          ),
          maxRetries: TITLE_MAX_RETRIES,
          abortSignal,
        }),
      TITLE_TIMEOUT_MS,
    ));
  } catch (error) {
    await recordFailure();
    throw error;
  }

  let newTitle = output.title;
  if (newTitle.length > 30) {
    newTitle = newTitle.slice(0, 29) + "…";
  }
  // why: this write skips zod; a too-short title is not padded, a later turn retries
  if (!chatSchema.shape.title.safeParse(newTitle).success) {
    logger.warn({ chatId, title: newTitle }, "Generated chat title rejected");
    await recordFailure();
    return null;
  }

  const updateResult = await db
    .update(chatTable)
    .set({ title: newTitle, updatedAt: new Date() })
    .where(
      and(
        eq(chatTable.id, chatId),
        eq(chatTable.workspaceId, workspaceId),
        eq(chatTable.title, UNTITLED_CHAT_TITLE),
      ),
    )
    .returning({
      id: chatTable.id,
      title: chatTable.title,
    });

  return updateResult[0] ?? null;
};

type ReadyTitle = {
  status: "ready";
  chat: TitleChat;
  messages: PlatypusUIMessage[];
  provider: ProviderRow;
};

type TitleReadiness =
  | ReadyTitle
  | { status: "skip" }
  | { status: "invisible"; providerId: string; fromOverride: boolean };

const prepareTitle = async (
  params: GenerateChatMetadataParams,
): Promise<TitleReadiness> => {
  const { chatId, workspaceId } = params;

  const chat = await readTitleChat(chatId, workspaceId);
  if (!chat) return { status: "skip" };

  if (chat.title !== UNTITLED_CHAT_TITLE) return { status: "skip" };
  if (chat.titleFailures >= MAX_TITLE_FAILURES) return { status: "skip" };

  const { messages } = await loadActivePath(chat.id, chat.activeLeafId);
  if (!hasUserText(messages)) return { status: "skip" };

  const titleProvider = await readTitleProvider(params);
  if (titleProvider.status === "no-workspace") return { status: "skip" };
  if (titleProvider.status === "invisible") {
    return {
      status: "invisible",
      providerId: titleProvider.providerId,
      fromOverride: titleProvider.fromOverride,
    };
  }
  return {
    status: "ready",
    chat,
    messages,
    provider: titleProvider.provider,
  };
};

export const generateChatMetadata = async (
  params: GenerateChatMetadataParams,
): Promise<{ id: string; title: string } | null> => {
  const readiness = await prepareTitle(params);
  if (readiness.status === "invisible") {
    logger.warn(
      {
        chatId: params.chatId,
        workspaceId: params.workspaceId,
        providerId: readiness.providerId,
        fromTaskModelOverride: readiness.fromOverride,
      },
      "Chat titling skipped: provider is not visible in this workspace",
    );
    return null;
  }
  if (readiness.status !== "ready") return null;

  return titleChat({
    chat: readiness.chat,
    messages: readiness.messages,
    provider: readiness.provider,
    workspaceId: params.workspaceId,
  });
};

export const startEarlyChatTitle = async (
  params: StartEarlyChatTitleParams,
): Promise<void> => {
  const { workspaceId, providerId, modelId } = params;

  const readiness = await prepareTitle(params);
  if (readiness.status !== "ready") return;
  const { provider } = readiness;

  if (readiness.chat.titleFailures >= MAX_TITLE_FAILURES - 1) return;

  if (provider.taskModelId.trim() === "") return;

  if (
    isChatsOwnModel(
      { providerId: provider.id, modelId: provider.taskModelId },
      { providerId, modelId },
    )
  ) {
    return;
  }

  await titleChat({
    chat: readiness.chat,
    messages: readiness.messages,
    provider,
    workspaceId,
  });
};
