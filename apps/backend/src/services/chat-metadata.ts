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

/**
 * Bounds on titling (issue #1618). A title needs the start of a conversation,
 * not all of it. The deadline covers the call's retries. After
 * `MAX_TITLE_FAILURES` failed attempts a Chat stays Untitled until the User
 * names it.
 */
const MAX_CONVERSATION_CHARS = 8_000;
const TITLE_TIMEOUT_MS = 30_000;
const TITLE_MAX_OUTPUT_TOKENS = 2_048;
const TITLE_MAX_RETRIES = 1;
export const MAX_TITLE_FAILURES = 3;

export type GenerateChatMetadataParams = {
  chatId: string;
  workspaceId: string;
  orgId: string;
  /**
   * Provider to title with when the workspace has no task-model override.
   * For run-lifecycle callers this is the run's resolved provider id, which is
   * always present for both direct-provider and agent runs (the chat row nulls
   * the provider column for agent runs, so read it from the resolved plan).
   */
  providerId: string;
};

export type StartEarlyChatTitleParams = GenerateChatMetadataParams & {
  /**
   * The turn's resolved concrete model id (ADR-0017), never the alias a Chat
   * may store: the early decision compares models, not references.
   */
  modelId: ConcreteModelId;
};

/** Whether the messages contain at least one user message carrying text. */
const hasUserText = (messages: PlatypusUIMessage[]): boolean =>
  messages.some(
    (m) =>
      m.role === "user" &&
      m.parts.some((p) => p.type === "text" && p.text.trim().length > 0),
  );

/** The Chat columns titling reads. */
type TitleChat = {
  id: string;
  title: string;
  activeLeafId: string | null;
  titleFailures: number;
};

/** Reads the Chat titling decides from, scoped to its Workspace. */
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

/** The Provider that titles this Workspace's Chats, or why there is none. */
type TitleProvider =
  | { status: "resolved"; provider: ProviderRow }
  | { status: "no-workspace" }
  | { status: "invisible"; providerId: string; fromOverride: boolean };

/**
 * Resolves the Provider a Chat in this Workspace is titled with: the
 * Workspace's task-model Provider if it sets one, otherwise the supplied
 * `providerId`. Through the Scoped-resource authority, as every other resource
 * a Chat turn reaches is: a Shared Provider titles here only where an
 * Attachment makes it visible to this Workspace (ADR-0007).
 */
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

/**
 * Titles a Chat already known to be Untitled, with a Provider already resolved:
 * reads the Active path, calls the task model, and writes the title guarded on
 * the Chat still being Untitled.
 */
const titleChat = async (args: {
  chat: TitleChat;
  provider: ProviderRow;
  workspaceId: string;
}): Promise<{ id: string; title: string } | null> => {
  const { chat, provider, workspaceId } = args;
  const chatId = chat.id;

  const { messages } = await loadActivePath(chat.id, chat.activeLeafId);
  if (!hasUserText(messages)) return null;

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

  // Counted where a model call was made and produced nothing usable, so the
  // warning that titling gave up is logged once, by the attempt that hit it.
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
  // Truncate the title if it exceeds 30 characters. This is needed as some
  // models don't respect the limit mentioned in the above prompt :\
  if (newTitle.length > 30) {
    newTitle = newTitle.slice(0, 29) + "…";
  }
  // This write skips zod, so check the title here. A too-short one is not
  // padded: the chat stays Untitled and a later turn tries again, up to
  // `MAX_TITLE_FAILURES`.
  if (!chatSchema.shape.title.safeParse(newTitle).success) {
    logger.warn({ chatId, title: newTitle }, "Generated chat title rejected");
    await recordFailure();
    return null;
  }

  // Conditional write: only apply while the row is still "Untitled". This is
  // the atomic concurrency backstop — the first writer wins, later writers
  // (a second overlapping run, or the client fast-path) match zero rows.
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

/** A Chat ready to be titled, and the Provider that will title it. */
type ReadyTitle = {
  status: "ready";
  chat: TitleChat;
  provider: ProviderRow;
};

/**
 * Whether this Chat can be titled right now: ready, skipped, or skipped
 * because the Provider titling would use is not visible here.
 */
type TitleReadiness =
  | ReadyTitle
  | { status: "skip" }
  | { status: "invisible"; providerId: string; fromOverride: boolean };

/**
 * The checks every title attempt makes first: the Chat still exists, is still
 * Untitled, has not used up its failures, and has a Provider to title with.
 *
 * Shared so the early and end-of-run attempts decide identically. The end-of-run
 * caller says why an invisible Provider skipped it; the early one stays quiet,
 * since the end-of-run attempt will say it.
 */
const prepareTitle = async (
  params: GenerateChatMetadataParams,
): Promise<TitleReadiness> => {
  const { chatId, workspaceId } = params;

  const chat = await readTitleChat(chatId, workspaceId);
  if (!chat) return { status: "skip" };

  // Idempotency short-circuit: never re-title, never clobber a rename. The
  // conditional write below is the real concurrency backstop; this just avoids
  // a pointless model call in the common already-titled case.
  if (chat.title !== UNTITLED_CHAT_TITLE) return { status: "skip" };
  if (chat.titleFailures >= MAX_TITLE_FAILURES) return { status: "skip" };

  const titleProvider = await readTitleProvider(params);
  if (titleProvider.status === "no-workspace") return { status: "skip" };
  if (titleProvider.status === "invisible") {
    return {
      status: "invisible",
      providerId: titleProvider.providerId,
      fromOverride: titleProvider.fromOverride,
    };
  }
  return { status: "ready", chat, provider: titleProvider.provider };
};

/**
 * Generates and persists a chat's title with the task model, then returns the
 * updated row (or `null` when nothing was written).
 *
 * The end-of-run titling path. It is safe to call from the run lifecycle for any
 * terminal status and safe under concurrency:
 *
 * - It only ever titles a chat still named "Untitled" — a fast short-circuit
 *   avoids the model call for already-titled or user-renamed chats, and the
 *   final write is guarded `WHERE title = 'Untitled'` so the first generation
 *   wins and overlapping runs cannot double-write or clobber a rename.
 * - It requires at least one user message with text, so an empty/failed-before-
 *   input chat is left untitled rather than fed an empty prompt.
 *
 * `startEarlyChatTitle` shares its checks and its write, so the two attempts
 * cannot disagree about when a Chat is titled.
 *
 * Provider resolution honors the workspace task-model override, falling back to
 * the supplied `providerId`.
 */
export const generateChatMetadata = async (
  params: GenerateChatMetadataParams,
): Promise<{ id: string; title: string } | null> => {
  const readiness = await prepareTitle(params);
  if (readiness.status === "invisible") {
    // Titling is fire-and-forget, so an unresolvable provider leaves chats
    // named "Untitled" with nothing else to show for it. Say so: the usual
    // cause is a task-model override naming an Organization-scoped Provider
    // that is not attached to this Workspace, which reads as "titling just
    // stopped" from the outside.
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
    provider: readiness.provider,
    workspaceId: params.workspaceId,
  });
};

/**
 * Starts a title attempt before the turn's reply is generated, when titling
 * would use a different model from the turn's (issue #2017).
 *
 * Everything titling reads — the User's message on the Active path — is stored
 * when the turn's plan resolves, so a slow first reply need not leave the Chat
 * Untitled for its whole duration. The attempt is made only when the Provider
 * that titles is not the turn's Provider, or its task model is not the turn's
 * concrete model; when they are the same model, titling waits for the run to
 * end as it always has, so one model is never asked for two things at once.
 *
 * Callers start this without awaiting it and keep its promise, so the
 * end-of-run attempt can wait for it first. A failure is not swallowed here:
 * it counts toward `MAX_TITLE_FAILURES` exactly as any other title call does,
 * and the caller catches and logs it (the run is never affected), leaving the
 * end-of-run attempt to try again.
 */
export const startEarlyChatTitle = async (
  params: StartEarlyChatTitleParams,
): Promise<void> => {
  const { workspaceId, providerId, modelId } = params;

  // No readiness — no Provider to title with, or nothing to title — means no
  // early attempt. The end-of-run attempt behaves as it always has, and says
  // why it skipped an invisible Provider.
  const readiness = await prepareTitle(params);
  if (readiness.status !== "ready") return;
  const { provider } = readiness;

  // A Provider with no task model configured has no title model to call: an
  // early attempt would be a doomed call, and would count a failure that the
  // end-of-run attempt is about to count again.
  if (provider.taskModelId.trim() === "") return;

  if (
    isChatsOwnModel({
      taskProviderId: provider.id,
      taskModelId: provider.taskModelId,
      chatProviderId: providerId,
      chatModelId: modelId,
    })
  ) {
    return;
  }

  await titleChat({ chat: readiness.chat, provider, workspaceId });
};
