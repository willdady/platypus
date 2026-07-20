import { generateText, Output } from "ai";
import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index.ts";
import {
  chat as chatTable,
  provider as providerTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { openProvider } from "./provider.ts";
import { dedupeArray, toKebabCase } from "../utils.ts";
import { UNTITLED_CHAT_TITLE, type Provider } from "@platypus/schemas";
import type { PlatypusUIMessage } from "../types.ts";

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
 * Generates and persists a chat's title + tags with the task model, then
 * returns the updated row (or `null` when nothing was written).
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
): Promise<typeof chatTable.$inferSelect | null> => {
  const { chatId, workspaceId, orgId, providerId } = params;

  // Fetch chat record.
  const chatRows = await db
    .select()
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

  const messages = (chat.messages as PlatypusUIMessage[]) || [];
  if (!hasUserText(messages)) return null;

  // Fetch workspace to check for a task-model provider override.
  const workspaceRows = await db
    .select()
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);
  const workspace = workspaceRows[0];
  if (!workspace) return null;

  // Use the workspace task-model provider if set, otherwise the supplied one.
  const effectiveProviderId = workspace.taskModelProviderId || providerId;

  const providerRows = await db
    .select()
    .from(providerTable)
    .where(
      and(
        eq(providerTable.id, effectiveProviderId),
        or(
          eq(providerTable.workspaceId, workspaceId),
          eq(providerTable.organizationId, orgId),
        ),
      ),
    )
    .limit(1);
  const provider = providerRows[0] as Provider | undefined;
  if (!provider) return null;

  // Fetch existing tags from all chats in the workspace so the model can reuse
  // them rather than minting near-duplicate variants.
  const existingTagsResult = await db.execute(sql`
    SELECT DISTINCT value as tag
    FROM ${chatTable}, jsonb_array_elements_text(${chatTable.tags})
    WHERE ${chatTable.workspaceId} = ${workspaceId}
  `);
  const existingTags = existingTagsResult.rows.map((row) => row.tag as string);

  const model = openProvider(provider).languageModel(provider.taskModelId);

  const conversationText = messages
    .map((m) => {
      const message = m.parts.map((p) => {
        if (p.type === "text") return p.text;
        return "";
      });
      return `${m.role}:\n${message.join("")}`;
    })
    .join("\n");

  const promptParts = [
    `Generate a short, descriptive title for this chat conversation. You MAY use at most one emoji. The complete title MUST NOT exceed 30 characters.`,
    `Also generate between 1 and 5 kebab-case tags relevant to the chat.`,
    `Each tag should ideally be a single word but no more than two words.`,
    `IMPORTANT: Avoid ambiguous words that lack context when viewed alone. For example, prefer "web-browser" over "chrome", "metal-finish" over "chrome", "programming-language" over "python", or "file-format" over "pdf". Tags should be descriptive enough to be understood without seeing the conversation.`,
  ];

  // Add existing tags context if available.
  if (existingTags.length > 0) {
    promptParts.push(
      `Existing tags in this workspace: ${existingTags.join(", ")}`,
    );
    promptParts.push(
      `Prefer using tags from the existing list when they accurately describe the conversation. Only create new tags if none of the existing tags are applicable.`,
    );
  }

  promptParts.push(`Conversation:\n${conversationText}`);

  const { output } = await generateText({
    model,
    output: Output.object({
      schema: z.object({
        title: z.string(),
        tags: z.array(z.string()),
      }),
    }),
    prompt: promptParts.join("\n"),
  });

  let newTitle = output.title;
  // Truncate the title if it exceeds 30 characters. This is needed as some
  // models don't respect the limit mentioned in the above prompt :\
  if (newTitle.length > 30) {
    newTitle = newTitle.slice(0, 29) + "…";
  }

  // Enforce kebab-case tags and dedupe.
  const newTags = dedupeArray(output.tags.map(toKebabCase));

  // Conditional write: only apply while the row is still "Untitled". This is
  // the atomic concurrency backstop — the first writer wins, later writers
  // (a second overlapping run, or the client fast-path) match zero rows.
  const updateResult = await db
    .update(chatTable)
    .set({ title: newTitle, tags: newTags, updatedAt: new Date() })
    .where(
      and(
        eq(chatTable.id, chatId),
        eq(chatTable.workspaceId, workspaceId),
        eq(chatTable.title, UNTITLED_CHAT_TITLE),
      ),
    )
    .returning();

  return updateResult[0] ?? null;
};
