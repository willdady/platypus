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
import {
  drizzleTaskModelQueries,
  resolveTaskModelProvider,
} from "./task-model.ts";
import { UNTITLED_CHAT_TITLE, chatSchema } from "@platypus/schemas";
import type { PlatypusUIMessage } from "../types.ts";
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

/** Whether the messages contain at least one user message carrying text. */
const hasUserText = (messages: PlatypusUIMessage[]): boolean =>
  messages.some(
    (m) =>
      m.role === "user" &&
      m.parts.some((p) => p.type === "text" && p.text.trim().length > 0),
  );

/**
 * Generates and persists a chat's title with the task model, then returns the
 * updated row (or `null` when nothing was written).
 *
 * This is the single, authoritative titling path. It is safe to call from the
 * run lifecycle for any terminal status and safe under concurrency:
 *
 * - It only ever titles a chat still named "Untitled" — a fast short-circuit
 *   avoids the model call for already-titled or user-renamed chats, and the
 *   final write is guarded `WHERE title = 'Untitled'` so the first generation
 *   wins and overlapping runs cannot double-write or clobber a rename.
 * - It requires at least one user message with text, so an empty/failed-before-
 *   input chat is left untitled rather than fed an empty prompt.
 *
 * Provider resolution honors the workspace task-model override, falling back to
 * the supplied `providerId`.
 */
export const generateChatMetadata = async (
  params: GenerateChatMetadataParams,
): Promise<{ id: string; title: string } | null> => {
  const { chatId, workspaceId, orgId, providerId } = params;

  // Fetch chat record: only what titling reads, not its memory snapshot.
  const chatRows = await db
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
  const chat = chatRows[0];
  if (!chat) return null;

  // Idempotency short-circuit: never re-title, never clobber a rename. The
  // conditional write below is the real concurrency backstop; this just avoids
  // a pointless model call in the common already-titled case.
  if (chat.title !== UNTITLED_CHAT_TITLE) return null;
  if (chat.titleFailures >= MAX_TITLE_FAILURES) return null;

  const { messages } = await loadActivePath(chat.id, chat.activeLeafId);
  if (!hasUserText(messages)) return null;

  // Fetch the workspace to check for a task-model provider override.
  const workspaceRows = await db
    .select()
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);
  const workspace = workspaceRows[0];
  if (!workspace) return null;

  // The Workspace's task-model Provider if it sets one, otherwise the Chat's
  // own Provider. Resolved through the Scoped-resource authority, as every
  // other resource a Chat turn reaches is: a Shared Provider titles here only
  // where an Attachment makes it visible to this Workspace (ADR-0007).
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
    // Titling is fire-and-forget, so an unresolvable provider leaves chats
    // named "Untitled" with nothing else to show for it. Say so: the usual
    // cause is a task-model override naming an Organization-scoped Provider
    // that is not attached to this Workspace, which reads as "titling just
    // stopped" from the outside.
    logger.warn(
      {
        chatId,
        workspaceId,
        providerId: taskProvider.providerId,
        fromTaskModelOverride: taskProvider.fromOverride,
      },
      "Chat titling skipped: provider is not visible in this workspace",
    );
    return null;
  }
  const provider = taskProvider.provider;

  const model = openProvider(provider, { sessionId: chatId }).languageModel(
    pointerSettingModelId(provider.taskModelId),
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
          maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
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
