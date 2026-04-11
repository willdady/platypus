import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import {
  convertToModelMessages,
  createIdGenerator,
  generateText,
  Output,
  streamText,
  APICallError,
  LoadAPIKeyError,
} from "ai";
import { stepCountIs } from "ai";
import { db } from "../index.ts";
import { dedupeArray, toKebabCase } from "../utils.ts";
import {
  chat as chatTable,
  provider as providerTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import {
  createModel,
  resolveChatContext,
  loadTools,
  loadSkills,
  loadSubAgents,
  createSearchTools,
  resolveGenerationConfig,
  fetchUserContexts,
  fetchFormattedMemories,
  prepareAgentTools,
  type ChatContext,
  type GenerationConfig,
} from "../services/chat-execution.ts";
import {
  chatGenerateMetadataSchema,
  chatSubmitSchema,
  chatUpdateSchema,
  type ChatSubmitData,
  type Provider,
} from "@platypus/schemas";
import { and, desc, eq, or, sql, isNull } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceOwner,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";
import { type PlatypusUIMessage } from "../types.ts";
import {
  extractFiles,
  inlineFileUrls,
  rewriteStorageUrls,
  deleteFiles,
} from "../storage/utils.ts";

/**
 * Upserts the chat record in the database.
 */
const upsertChatRecord = async (
  id: string,
  orgId: string,
  workspaceId: string,
  messages: PlatypusUIMessage[],
  context: ChatContext,
  config: GenerationConfig,
  data: ChatSubmitData,
) => {
  const { resolvedAgentId, resolvedProviderId, resolvedModelId } = context;

  // Extract files from messages and store them
  const processedMessages = await extractFiles(messages, {
    orgId,
    workspaceId,
    chatId: id,
  });

  // Prepare values for DB
  const dbValues = {
    messages: processedMessages,
    agentId: resolvedAgentId || null,
    providerId: resolvedAgentId ? null : resolvedProviderId,
    modelId: resolvedAgentId ? null : resolvedModelId,
    systemPrompt: resolvedAgentId ? null : config.systemPrompt || null,
    temperature: resolvedAgentId ? null : config.temperature || null,
    topP: resolvedAgentId ? null : config.topP || null,
    topK: resolvedAgentId ? null : config.topK || null,
    seed: resolvedAgentId ? null : data.seed || null,
    presencePenalty: resolvedAgentId ? null : config.presencePenalty || null,
    frequencyPenalty: resolvedAgentId ? null : config.frequencyPenalty || null,
    updatedAt: new Date(),
  };

  try {
    // Upsert chat record - try update first, then insert if not found
    const updateResult = await db
      .update(chatTable)
      .set(dbValues)
      .where(and(eq(chatTable.id, id), eq(chatTable.workspaceId, workspaceId)))
      .returning();

    // If no rows were updated, insert the record
    if (updateResult.length === 0) {
      await db.insert(chatTable).values({
        id,
        workspaceId,
        title: "Untitled",
        createdAt: new Date(),
        ...dbValues,
      });
    }

    logger.info(
      `Successfully upserted chat '${id}' in workspace '${workspaceId}'`,
    );
  } catch (error) {
    logger.error(
      { error, chatId: id, workspaceId },
      "Error upserting chat record",
    );
  }
};

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

    const records = await db
      .select({
        id: chatTable.id,
        title: chatTable.title,
        isPinned: chatTable.isPinned,
        tags: chatTable.tags,
        agentId: chatTable.agentId,
        providerId: chatTable.providerId,
        modelId: chatTable.modelId,
        createdAt: chatTable.createdAt,
        updatedAt: chatTable.updatedAt,
      })
      .from(chatTable)
      .where(
        and(
          eq(chatTable.workspaceId, workspaceId),
          isNull(chatTable.triggerId),
          searchFilter,
        ),
      )
      .orderBy(desc(chatTable.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({ results: records });
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
      return c.json({ message: "Chat not found" }, 404);
    }

    // Rewrite storage:// URLs to HTTP URLs
    const chat = record[0];
    const origin = new URL(c.req.url).origin;
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
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    const data = c.req.valid("json");
    const { messages = [] } = data;

    // 1. Fetch workspace to get system prompt
    const workspaceRecord = await db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, workspaceId))
      .limit(1);

    if (workspaceRecord.length === 0) {
      throw new Error(`Workspace '${workspaceId}' not found`);
    }
    const workspace = workspaceRecord[0];

    // 2. Resolve Context (Agent vs Direct) & Provider
    let context: Awaited<ReturnType<typeof resolveChatContext>>;
    try {
      context = await resolveChatContext(data, orgId, workspaceId);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to resolve chat context";
      return c.json({ message }, 400);
    }
    const {
      provider,
      agent,
      resolvedAgentId,
      resolvedModelId,
      resolvedMaxSteps,
    } = context;

    // 3. Initialize Model
    const [aiProvider, model] = createModel(provider, resolvedModelId);

    // 4. Load Tools (Static & MCP)
    const frontendUrl = process.env.FRONTEND_URL;
    const { tools, mcpClients } = await loadTools(
      agent,
      workspaceId,
      orgId,
      frontendUrl,
    );

    // 4b. MCP client lifecycle management - close on abort to prevent leaks
    let mcpClientsClosed = false;
    const closeMcpClients = async () => {
      if (mcpClientsClosed) return;
      mcpClientsClosed = true;
      for (const client of mcpClients) {
        try {
          await client.close();
        } catch (e) {
          logger.error({ error: e }, "Error closing MCP client");
        }
      }
    };

    if (mcpClients.length > 0) {
      c.req.raw.signal.addEventListener("abort", () => {
        closeMcpClients();
      });
    }

    // 5. Configure Search (if enabled)
    if (data.search) {
      Object.assign(tools, createSearchTools(provider, aiProvider));
    }

    // 6. Fetch Skills
    const skills = await loadSkills(agent, workspaceId);

    // 7. Fetch sub-agent details and create delegate tools (only for parent agents)
    const { subAgents, subAgentTools } = await loadSubAgents(
      agent,
      orgId,
      workspaceId,
      frontendUrl,
    );
    Object.assign(tools, subAgentTools);

    // 8. Fetch User Contexts (global and workspace-specific)
    const user = c.get("user")!;
    const { userGlobalContext, userWorkspaceContext } = await fetchUserContexts(
      user.id,
      workspaceId,
    );

    // 9. Fetch memories for the user (user-level + workspace-level)
    const memoriesFormatted = await fetchFormattedMemories(
      user.id,
      workspaceId,
    );

    // 10. Prepare Generation Config (Merge Agent & Request params)
    const config = await resolveGenerationConfig(
      data,
      workspaceId,
      agent,
      workspace.context || undefined,
      skills,
      { id: user.id, name: user.name },
      userGlobalContext,
      userWorkspaceContext,
      subAgents,
      memoriesFormatted,
    );

    // 11. Inject loadSkill tool if skills exist
    prepareAgentTools(tools, skills, workspaceId);

    // 13. Stream Response
    const { systemPrompt, ...restConfig } = config;

    logger.debug({ systemPrompt }, "System prompt for chat");

    const inlinedMessages = await inlineFileUrls(
      messages,
      new URL(c.req.url).origin,
    );

    const result = streamText({
      model: model as any,
      messages: await convertToModelMessages(inlinedMessages),
      stopWhen: [stepCountIs(resolvedMaxSteps)],
      tools,
      system: systemPrompt,
      ...restConfig,
    });

    return result.toUIMessageStreamResponse<PlatypusUIMessage>({
      originalMessages: messages,
      generateMessageId: createIdGenerator({
        prefix: "msg",
        size: 16,
      }),
      messageMetadata: () =>
        resolvedAgentId ? { agentId: resolvedAgentId } : undefined,
      onError: (error) => {
        logger.error({ error }, "Chat stream error");
        if (LoadAPIKeyError.isInstance(error)) {
          return "AI provider API key is missing or not configured.";
        }
        if (APICallError.isInstance(error)) {
          if (error.statusCode === 401 || error.statusCode === 403) {
            return "AI provider authentication failed. Your API key may be invalid or expired.";
          }
          if (error.statusCode === 429) {
            return "AI provider rate limit exceeded. Please try again later.";
          }
          if (error.statusCode != null && error.statusCode >= 500) {
            return "AI provider is currently unavailable. Please try again later.";
          }
          return `AI provider error: ${error.message}`;
        }
        if (error instanceof Error) {
          return error.message;
        }
        return "An unexpected error occurred.";
      },
      onFinish: async ({ messages }) => {
        try {
          // Close all MCP clients
          await closeMcpClients();

          // Upsert chat record
          await upsertChatRecord(
            data.id,
            orgId,
            workspaceId,
            messages,
            context,
            config,
            data,
          );
        } catch (error) {
          logger.error({ error }, "Error in onFinish");
        }
      },
    });
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
      return c.json({ message: "Chat not found" }, 404);
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
      return c.json({ message: "Chat not found" }, 404);
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
      return c.json({ message: "Chat not found" }, 404);
    }
    const chat = chatRecord[0];

    // Fetch workspace to check for task model provider override
    const workspaceRecord = await db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, workspaceId))
      .limit(1);

    if (workspaceRecord.length === 0) {
      return c.json({ message: "Workspace not found" }, 404);
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
      return c.json({ message: "Provider not found" }, 404);
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
    let [_, model] = createModel(provider, provider.taskModelId);

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
