import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import {
  convertToModelMessages,
  createIdGenerator,
  generateText,
  Output,
  streamText,
  type UIMessage,
  type Tool,
} from "ai";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic, type AnthropicProvider } from "@ai-sdk/anthropic";
import {
  createGoogleGenerativeAI,
  type GoogleGenerativeAIProvider,
} from "@ai-sdk/google";
import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { stepCountIs } from "ai";
import { db } from "../index.ts";
import { dedupeArray, toKebabCase } from "../utils.ts";
import {
  agent as agentTable,
  chat as chatTable,
  mcp as mcpTable,
  provider as providerTable,
  workspace as workspaceTable,
  skill as skillTable,
} from "../db/schema.ts";
import { getToolSet } from "../tools/index.ts";
import { createLoadSkillTool } from "../tools/skill.ts";
import { renderSystemPrompt } from "../system-prompt.ts";
import {
  chatGenerateMetadataSchema,
  chatSubmitSchema,
  chatUpdateSchema,
  type ChatSubmitData,
  type Provider,
  type Skill,
} from "@platypus/schemas";
import { and, desc, eq, or, sql, inArray } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";

// --- Types ---

type ChatContext = {
  provider: Provider;
  agent?: typeof agentTable.$inferSelect;
  resolvedModelId: string;
  resolvedProviderId: string;
  resolvedAgentId?: string;
  resolvedMaxSteps: number;
};

type GenerationConfig = {
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  skills?: Array<Pick<Skill, "name" | "description">>;
};

// --- Helper Functions ---

/**
 * Creates a LanguageModel instance based on the provider configuration.
 */
const createModel = (provider: Provider, modelId: string) => {
  if (provider.providerType === "OpenAI") {
    const openai = createOpenAI({
      baseURL: provider.baseUrl ?? undefined,
      apiKey: provider.apiKey ?? undefined,
      headers: provider.headers ?? undefined,
      organization: provider.organization ?? undefined,
      project: provider.project ?? undefined,
    });
    return [openai, openai(modelId)] as const;
  } else if (provider.providerType === "OpenRouter") {
    const openRouter = createOpenRouter({
      baseURL: provider.baseUrl ?? undefined,
      apiKey: provider.apiKey ?? undefined,
      headers: provider.headers ?? undefined,
      extraBody: provider.extraBody ?? undefined,
    });
    return [openRouter, openRouter(modelId)] as const;
  } else if (provider.providerType === "Bedrock") {
    const bedrock = createAmazonBedrock({
      baseURL: provider.baseUrl ?? undefined,
      region: provider.region ?? undefined,
      apiKey: provider.apiKey ?? undefined,
      headers: provider.headers ?? undefined,
    });
    return [bedrock, bedrock(modelId)] as const;
  } else if (provider.providerType === "Google") {
    const google = createGoogleGenerativeAI({
      baseURL: provider.baseUrl ?? undefined,
      apiKey: provider.apiKey ?? undefined,
      headers: provider.headers ?? undefined,
    });
    return [google, google(modelId)] as const;
  } else if (provider.providerType === "Anthropic") {
    const anthropic = createAnthropic({
      baseURL: provider.baseUrl ?? undefined,
      apiKey: provider.apiKey ?? undefined,
      headers: provider.headers ?? undefined,
    });
    return [anthropic, anthropic(modelId)] as const;
  } else {
    throw new Error(`Unrecognized provider type '${provider.providerType}'`);
  }
};

/**
 * Resolves the chat context: determines the agent (if any), provider, and model to use.
 */
const resolveChatContext = async (
  data: ChatSubmitData,
  orgId: string,
  workspaceId: string,
): Promise<ChatContext> => {
  const { agentId, providerId, modelId, search } = data;

  let resolvedProviderId: string;
  let resolvedModelId: string;
  let resolvedAgentId: string | undefined;
  let resolvedMaxSteps = 1;
  let agent: typeof agentTable.$inferSelect | undefined;

  if (agentId) {
    // Agent selected - fetch agent and use its configuration
    resolvedAgentId = agentId;
    const agentRecord = await db
      .select()
      .from(agentTable)
      .where(
        and(
          eq(agentTable.id, agentId),
          eq(agentTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (agentRecord.length === 0) {
      throw new Error(`Agent '${agentId}' not found`);
    }
    agent = agentRecord[0];
    resolvedProviderId = agent.providerId;
    resolvedModelId = agent.modelId;
    resolvedMaxSteps = agent.maxSteps ?? 1;
  } else if (providerId && modelId) {
    // Direct provider/model selection
    resolvedProviderId = providerId;
    resolvedModelId = modelId;
    resolvedAgentId = undefined;
  } else {
    throw new Error("Must provide either agentId or (providerId and modelId)");
  }

  // Get the provider record from the database
  const providerRecord = await db
    .select()
    .from(providerTable)
    .where(
      and(
        eq(providerTable.id, resolvedProviderId),
        or(
          eq(providerTable.workspaceId, workspaceId),
          eq(providerTable.organizationId, orgId),
        ),
      ),
    )
    .limit(1);

  if (providerRecord.length === 0) {
    throw new Error(`Provider with id '${resolvedProviderId}' not found`);
  }
  const provider = providerRecord[0] as Provider;

  // Check the received modelId is enabled/defined on the provider
  if (!provider.modelIds.includes(resolvedModelId)) {
    throw new Error(
      `Model id '${resolvedModelId}' not enabled for provider '${resolvedProviderId}'`,
    );
  }

  // If `search === true` and we're using the OpenRouter provider, append ":online" to the modelId
  if (
    search &&
    provider.providerType === "OpenRouter" &&
    !(resolvedModelId || "").includes(":online")
  ) {
    resolvedModelId = `${resolvedModelId}:online`;
  }

  return {
    provider,
    agent,
    resolvedModelId,
    resolvedProviderId,
    resolvedAgentId,
    resolvedMaxSteps,
  };
};

/**
 * Loads tools for the chat session, including static tools and MCP clients.
 */
const loadTools = async (
  agent: typeof agentTable.$inferSelect | undefined,
  workspaceId: string,
): Promise<{ tools: Record<string, Tool>; mcpClients: any[] }> => {
  const tools: Record<string, Tool> = {};
  const mcpClients: any[] = [];

  if (!agent || !agent.toolSetIds || agent.toolSetIds.length === 0) {
    return { tools, mcpClients };
  }

  for (const toolSetId of agent.toolSetIds) {
    try {
      // Try to load as static tool set first
      const toolSet = getToolSet(toolSetId);
      Object.assign(tools, toolSet.tools);
    } catch (error) {
      // If static tool set not found, try to load as MCP
      const mcpRecord = await db
        .select()
        .from(mcpTable)
        .where(
          and(
            eq(mcpTable.id, toolSetId),
            eq(mcpTable.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (mcpRecord.length > 0) {
        const mcp = mcpRecord[0];
        if (mcp.url) {
          const mcpClient = await createMCPClient({
            transport: {
              type: "http",
              url: mcp.url,
              headers:
                mcp.authType === "Bearer"
                  ? { Authorization: `Bearer ${mcp.bearerToken}` }
                  : undefined,
            },
          });
          const mcpTools = await mcpClient.tools();
          Object.assign(tools, mcpTools);
          mcpClients.push(mcpClient);
        } else {
          logger.warn(`MCP '${toolSetId}' has no URL configured`);
        }
      } else {
        logger.warn(
          `Tool set with id '${toolSetId}' not found as static tool set or MCP`,
        );
      }
    }
  }

  return { tools, mcpClients };
};

/**
 * Creates provider-specific search tools if enabled.
 */
const createSearchTools = (
  provider: Provider,
  aiProvider: any,
): Record<string, Tool> => {
  const tools: Record<string, any> = {};

  if (provider.providerType === "OpenAI") {
    tools.web_search = (aiProvider as OpenAIProvider).tools.webSearch({
      externalWebAccess: true,
      searchContextSize: "high",
    });
  } else if (provider.providerType === "Google") {
    tools.google_search = (
      aiProvider as GoogleGenerativeAIProvider
    ).tools.googleSearch({});
  } else if (provider.providerType === "Anthropic") {
    tools.web_search = (
      aiProvider as AnthropicProvider
    ).tools.webSearch_20250305({
      maxUses: 5,
    });
  }

  return tools;
};

/**
 * Resolves the generation configuration (system prompt, temperature, etc.)
 * by merging agent settings with request overrides and workspace context.
 */
const resolveGenerationConfig = async (
  data: ChatSubmitData,
  workspaceId: string,
  agent?: typeof agentTable.$inferSelect,
  workspaceContext?: string,
  skills?: Array<Pick<Skill, "name" | "description">>,
): Promise<GenerationConfig> => {
  const config: GenerationConfig = {};
  const source = agent || data;

  Object.assign(
    config,
    source.temperature != null && { temperature: source.temperature },
    source.topP != null && { topP: source.topP },
    source.topK != null && { topK: source.topK },
    source.frequencyPenalty != null && {
      frequencyPenalty: source.frequencyPenalty,
    },
    source.presencePenalty != null && {
      presencePenalty: source.presencePenalty,
    },
  );

  const agentSystemPrompt =
    (agent ? agent.systemPrompt : data.systemPrompt) || undefined;

  // Render the system prompt using the template
  const systemPrompt = renderSystemPrompt({
    workspaceId,
    workspaceContext,
    agentSystemPrompt,
    skills,
  });

  config.systemPrompt = systemPrompt;
  return config;
};

/**
 * Upserts the chat record in the database.
 */
const upsertChatRecord = async (
  id: string,
  workspaceId: string,
  messages: any[],
  context: ChatContext,
  config: GenerationConfig,
  data: ChatSubmitData,
) => {
  const { resolvedAgentId, resolvedProviderId, resolvedModelId } = context;

  // Prepare values for DB
  const dbValues = {
    messages,
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
  requireWorkspaceAccess(),
  sValidator(
    "query",
    z.object({
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  ),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const { limit: limitStr, offset: offsetStr } = c.req.valid("query");

    const limit = Math.min(parseInt(limitStr ?? "100") || 100, 100);
    const offset = parseInt(offsetStr ?? "0") || 0;

    const records = await db
      .select({
        id: chatTable.id,
        title: chatTable.title,
        isStarred: chatTable.isStarred,
        tags: chatTable.tags,
        agentId: chatTable.agentId,
        providerId: chatTable.providerId,
        modelId: chatTable.modelId,
        createdAt: chatTable.createdAt,
        updatedAt: chatTable.updatedAt,
      })
      .from(chatTable)
      .where(eq(chatTable.workspaceId, workspaceId))
      .orderBy(desc(chatTable.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({ results: records });
  },
);

chat.get(
  "/tags",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess(),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;

    const result = await db.execute(sql`
      SELECT value as tag, count(*)::int as count
      FROM ${chatTable}, jsonb_array_elements_text(${chatTable.tags})
      WHERE ${chatTable.workspaceId} = ${workspaceId}
      GROUP BY tag
      ORDER BY count DESC
    `);

    return c.json({ results: result.rows });
  },
);

chat.get(
  "/:chatId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess(),
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
    return c.json(record[0]);
  },
);

chat.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess(),
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
    const context = await resolveChatContext(data, orgId, workspaceId);
    const { provider, agent, resolvedModelId } = context;

    // 3. Initialize Model
    const [aiProvider, model] = createModel(provider, resolvedModelId);

    // 4. Load Tools (Static & MCP)
    const { tools, mcpClients } = await loadTools(agent, workspaceId);

    // 5. Configure Search (if enabled)
    if (data.search) {
      Object.assign(tools, createSearchTools(provider, aiProvider));
    }

    // 6. Fetch Skills (if any)
    let skills: Array<Pick<Skill, "name" | "description">> = [];
    if (agent?.skillIds && agent.skillIds.length > 0) {
      const skillRecords = await db
        .select({ name: skillTable.name, description: skillTable.description })
        .from(skillTable)
        .where(
          and(
            eq(skillTable.workspaceId, workspaceId),
            inArray(skillTable.id, agent.skillIds),
          ),
        );
      skills = skillRecords;
    }

    // 7. Prepare Generation Config (Merge Agent & Request params)
    const config = await resolveGenerationConfig(
      data,
      workspaceId,
      agent,
      workspace.context || undefined,
      skills,
    );

    // 8. Inject load_skill tool if skills exist
    if (skills.length > 0) {
      tools.load_skill = createLoadSkillTool(workspaceId);
    }

    // 9. Stream Response
    const { systemPrompt, ...restConfig } = config;
    const result = streamText({
      model: model as any,
      messages: await convertToModelMessages(messages),
      stopWhen: stepCountIs(context.resolvedMaxSteps),
      tools,
      system: systemPrompt,
      ...restConfig,
    });

    return result.toUIMessageStreamResponse({
      originalMessages: messages,
      generateMessageId: createIdGenerator({
        prefix: "msg",
        size: 16,
      }),
      onFinish: async ({ messages }) => {
        try {
          // Close all MCP clients
          for (const mcpClient of mcpClients) {
            try {
              await mcpClient.close();
            } catch (error) {
              logger.error({ error }, "Error closing MCP client");
            }
          }

          // Upsert chat record
          await upsertChatRecord(
            data.id,
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
  requireWorkspaceAccess(),
  async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId")!;

    const result = await db
      .delete(chatTable)
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
      )
      .returning();

    if (result.length === 0) {
      return c.json({ message: "Chat not found" }, 404);
    }

    return c.json({ message: "Chat deleted successfully" }, 200);
  },
);

chat.put(
  "/:chatId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess(),
  sValidator("json", chatUpdateSchema),
  async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId")!;
    const { title, isStarred, tags } = c.req.valid("json");

    const result = await db
      .update(chatTable)
      .set({ title, isStarred, tags, updatedAt: new Date() })
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
  requireWorkspaceAccess(),
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

    // Fetch provider record
    const providerRecord = await db
      .select()
      .from(providerTable)
      .where(
        and(
          eq(providerTable.id, providerId),
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

    // Instantiate model
    let [_, model] = createModel(provider, provider.taskModelId);

    // Generate title
    const messages = (chat.messages as UIMessage[]) || [];
    const conversationText = messages
      .map((m) => {
        const message = m.parts.map((p) => {
          if (p.type === "text") return p.text;
          return "";
        });
        return `${m.role}:\n${message.join("")}`;
      })
      .join("\n");

    const { output } = await generateText({
      model: model as any,
      output: Output.object({
        schema: z.object({
          title: z.string(),
          tags: z.array(z.string()),
        }),
      }),
      prompt: [
        `Generate a short, descriptive title for this chat conversation. You MAY use at most one emoji. The complete title MUST NOT exceed 30 characters.`,
        `Also generate between 1 and 5 kebab-case tags relevant to the chat.`,
        `Each tag should ideally be a single word but no more than two words.`,
        `Conversation:\n${conversationText}`,
      ].join("\n"),
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
