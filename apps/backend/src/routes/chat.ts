import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { generateText, Output } from "ai";
import { db } from "../index.ts";
import { dedupeArray, toKebabCase } from "../utils.ts";
import {
  chat as chatTable,
  provider as providerTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { NotFoundError, ValidationError } from "../services/chat-execution.ts";
import { resolveRunTimeouts } from "../services/agent-run-settings.ts";
import { openProvider } from "../services/provider.ts";
import {
  chatGenerateMetadataSchema,
  chatSubmitSchema,
  chatUpdateSchema,
  type Provider,
} from "@platypus/schemas";
import { and, count, desc, eq, or, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceOwner,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { type PlatypusUIMessage } from "../types.ts";
import { rewriteStorageUrls, deleteFiles } from "../storage/utils.ts";
import { getOrigin } from "../utils/get-origin.ts";
import { agentRunner } from "../runs/agent-runner.ts";
import { ChatSink } from "../runs/sinks/chat-sink.ts";
import type { RunInput } from "../runs/types.ts";

// --- Routes ---

const chat = new Hono<{ Variables: Variables }>();

chat.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator(
    "query",
    z.object({
      limit: z.string().optional(),
      offset: z.string().optional(),
      search: z.string().optional(),
    }),
  ),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const { limit: limitStr, offset: offsetStr, search } = c.req.valid("query");

    const limit = Math.min(parseInt(limitStr ?? "100") || 100, 100);
    const offset = parseInt(offsetStr ?? "0") || 0;

    // Build search filter using ILIKE on title and tags
    const searchFilter =
      search && search.trim() !== ""
        ? or(
            sql`${chatTable.title} ILIKE ${"%" + search.trim() + "%"}`,
            sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${chatTable.tags}) AS t WHERE t ILIKE ${"%" + search.trim() + "%"})`,
          )
        : undefined;

    const whereClause = and(
      eq(chatTable.workspaceId, workspaceId),
      searchFilter,
    );

    const records = await db
      .select({
        id: chatTable.id,
        title: chatTable.title,
        status: chatTable.status,
        isPinned: chatTable.isPinned,
        tags: chatTable.tags,
        agentId: chatTable.agentId,
        providerId: chatTable.providerId,
        modelId: chatTable.modelId,
        createdAt: chatTable.createdAt,
        updatedAt: chatTable.updatedAt,
      })
      .from(chatTable)
      .where(whereClause)
      .orderBy(desc(chatTable.isPinned), desc(chatTable.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ totalCount }] = await db
      .select({ totalCount: count() })
      .from(chatTable)
      .where(whereClause);

    return c.json({ results: records, totalCount });
  },
);

chat.get(
  "/:chatId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId")!;

    const record = await db
      .select()
      .from(chatTable)
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
      )
      .limit(1);
    if (record.length === 0) {
      return c.json({ error: "Chat not found" }, 404);
    }

    // Rewrite storage:// URLs to HTTP URLs
    const chat = record[0];
    const origin = getOrigin(c);
    if (chat.messages) {
      chat.messages = rewriteStorageUrls(
        chat.messages as PlatypusUIMessage[],
        origin,
      );
    }

    return c.json(chat);
  },
);

chat.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", chatSubmitSchema),
  async (c) => {
    const scope = c.get("workspaceScope")!;
    const data = c.req.valid("json");

    const input: RunInput = {
      runId: data.id,
      request: data,
      messages: data.messages ?? [],
    };

    const sink = new ChatSink({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
    });

    const timeouts = await resolveRunTimeouts(scope.orgId, "chat");

    try {
      return await agentRunner.stream({
        scope,
        input,
        sink,
        options: {
          // c.req.raw.signal is intentionally NOT passed: chat runs
          // continue server-side regardless of the client connection.
          // The client cancels via POST /chat/:chatId/cancel.
          origin: getOrigin(c),
          frontendUrl: process.env.FRONTEND_URL,
          timeouts,
        },
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        return c.json({ message: error.message }, 400);
      }
      if (error instanceof NotFoundError) {
        return c.json({ message: error.message }, 404);
      }
      throw error;
    }
  },
);

chat.post(
  "/:chatId/cancel",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId")!;

    // Verify the chat belongs to this workspace before signalling cancel.
    // This is what makes a cross-workspace cancel return 404 rather than
    // silently no-op — runIds (which equal chat IDs) are otherwise the
    // only thing the registry sees.
    const record = await db
      .select({ id: chatTable.id })
      .from(chatTable)
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
      )
      .limit(1);

    if (record.length === 0) {
      return c.json({ error: "Chat not found" }, 404);
    }

    // Idempotent: cancel returns false for unknown / already-finished
    // runs, but we still respond 200 so flaky clients can safely retry.
    agentRunner.cancel(chatId);
    return c.json({ message: "Cancellation requested" }, 200);
  },
);

chat.delete(
  "/:chatId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId")!;

    // First fetch the chat to get its messages for file cleanup
    const chatRecord = await db
      .select()
      .from(chatTable)
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
      )
      .limit(1);

    if (chatRecord.length === 0) {
      return c.json({ error: "Chat not found" }, 404);
    }

    // Delete associated files from storage (best-effort)
    if (chatRecord[0].messages) {
      await deleteFiles(chatRecord[0].messages as PlatypusUIMessage[]);
    }

    // Delete the chat record
    await db
      .delete(chatTable)
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
      );

    return c.json({ message: "Chat deleted successfully" }, 200);
  },
);

chat.put(
  "/:chatId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", chatUpdateSchema),
  async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId")!;
    const { title, isPinned, tags } = c.req.valid("json");

    const result = await db
      .update(chatTable)
      .set({ title, isPinned, tags, updatedAt: new Date() })
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
      )
      .returning();

    if (result.length === 0) {
      return c.json({ error: "Chat not found" }, 404);
    }

    return c.json(result[0]);
  },
);

chat.post(
  "/:chatId/generate-metadata",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", chatGenerateMetadataSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId")!;
    const { providerId } = c.req.valid("json");

    // Fetch chat record
    const chatRecord = await db
      .select()
      .from(chatTable)
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
      )
      .limit(1);
    if (chatRecord.length === 0) {
      return c.json({ error: "Chat not found" }, 404);
    }
    const chat = chatRecord[0];

    // Fetch workspace to check for task model provider override
    const workspaceRecord = await db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, workspaceId))
      .limit(1);

    if (workspaceRecord.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    const workspace = workspaceRecord[0];

    // Use workspace task model provider if set, otherwise use request providerId
    const effectiveProviderId = workspace.taskModelProviderId || providerId;

    // Fetch provider record
    const providerRecord = await db
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

    if (providerRecord.length === 0) {
      return c.json({ error: "Provider not found" }, 404);
    }
    const provider = providerRecord[0] as Provider;

    // Fetch existing tags from all chats in the workspace
    const existingTagsResult = await db.execute(sql`
      SELECT DISTINCT value as tag
      FROM ${chatTable}, jsonb_array_elements_text(${chatTable.tags})
      WHERE ${chatTable.workspaceId} = ${workspaceId}
    `);
    const existingTags = existingTagsResult.rows.map(
      (row) => row.tag as string,
    );

    // Instantiate model
    const model = openProvider(provider).languageModel(provider.taskModelId);

    // Generate title
    const messages = (chat.messages as PlatypusUIMessage[]) || [];
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

    // Add existing tags context if available
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
      model: model as any,
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

    // Enforce kebab-case tags and dedupe
    const newTags = dedupeArray(output.tags.map(toKebabCase));

    // Update chat title and tags
    const updateResult = await db
      .update(chatTable)
      .set({ title: newTitle, tags: newTags, updatedAt: new Date() })
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
      )
      .returning();

    return c.json(updateResult[0]);
  },
);

export { chat };
