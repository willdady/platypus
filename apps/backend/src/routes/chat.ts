import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import {
  convertToModelMessages,
  type LanguageModel,
  streamText,
  generateObject,
  type UIMessage,
  createIdGenerator,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { stepCountIs } from "ai";
import { db } from "../index.ts";
import {
  chat as chatTable,
  provider as providerTable,
  agent as agentTable,
  mcp as mcpTable,
} from "../db/schema.ts";
import { getToolSet } from "../tools/index.ts";
import {
  chatSubmitSchema,
  chatUpdateSchema,
  chatGenerateMetadataSchema,
  type Provider,
} from "@agent-kit/schemas";
import { and, eq, desc } from "drizzle-orm";

/**
 * Creates a LanguageModel instance based on the provider configuration.
 * @param provider The provider configuration
 * @param modelId The model ID to use
 * @returns The instantiated LanguageModel
 */
const createModel = (provider: Provider, modelId: string): LanguageModel => {
  if (provider.providerType === "OpenAI") {
    const openai = createOpenAI({
      baseURL: provider.baseUrl ?? undefined,
      apiKey: provider.apiKey ?? undefined,
      headers: provider.headers ?? undefined,
      organization: provider.organization ?? undefined,
      project: provider.project ?? undefined,
    });
    return openai(modelId);
  } else if (provider.providerType === "OpenRouter") {
    const openRouter = createOpenRouter({
      baseURL: provider.baseUrl ?? undefined,
      apiKey: provider.apiKey ?? undefined,
      headers: provider.headers ?? undefined,
      extraBody: provider.extraBody ?? undefined,
    });
    return openRouter(modelId);
  } else if (provider.providerType === "Bedrock") {
    const bedrock = createAmazonBedrock({
      baseURL: provider.baseUrl ?? undefined,
      region: provider.region ?? undefined,
      apiKey: provider.apiKey ?? undefined,
      headers: provider.headers ?? undefined,
    });
    return bedrock(modelId);
  } else {
    throw new Error(`Unrecognized provider type '${provider.providerType}'`);
  }
};

const chat = new Hono();

chat.get(
  "/",
  sValidator(
    "query",
    z.object({
      workspaceId: z.string(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  ),
  async (c) => {
    const {
      workspaceId,
      limit: limitStr,
      offset: offsetStr,
    } = c.req.valid("query");

    if (!workspaceId) {
      return c.json(
        { message: "workspaceId query parameter is required" },
        400,
      );
    }

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
  "/:id",
  sValidator("query", z.object({ workspaceId: z.string() })),
  async (c) => {
    const id = c.req.param("id");
    const { workspaceId } = c.req.valid("query");

    const record = await db
      .select()
      .from(chatTable)
      .where(and(eq(chatTable.id, id), eq(chatTable.workspaceId, workspaceId)))
      .limit(1);
    if (record.length === 0) {
      return c.json({ message: "Chat not found" }, 404);
    }
    return c.json(record[0]);
  },
);

chat.post("/", sValidator("json", chatSubmitSchema), async (c) => {
  const data = c.req.valid("json");

  const {
    id,
    workspaceId,
    agentId,
    providerId,
    modelId,
    messages = [],
    systemPrompt,
    temperature,
    topP,
    topK,
    seed,
    presencePenalty,
    frequencyPenalty,
  } = data;

  // Agent handling logic
  let resolvedProviderId: string;
  let resolvedModelId: string;
  let resolvedAgentId: string | undefined;

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
    const agent = agentRecord[0];
    resolvedProviderId = agent.providerId;
    resolvedModelId = agent.modelId;
    // TODO: Apply agent's systemPrompt, temperature, etc. to streamText
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
        eq(providerTable.workspaceId, workspaceId),
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

  let model: LanguageModel = createModel(provider, resolvedModelId);

  // Build streamText parameters
  const streamTextParams: Parameters<typeof streamText>[0] = {
    model,
    messages: convertToModelMessages(messages),
    stopWhen: stepCountIs(20),
  };

  // Initialize MCP clients array for cleanup in onFinish
  const mcpClients: any[] = [];

  // Load agent's tools if agent is selected
  if (resolvedAgentId) {
    const agent = (
      await db
        .select()
        .from(agentTable)
        .where(eq(agentTable.id, resolvedAgentId))
        .limit(1)
    )[0];

    // Load agent's tools
    if (agent.toolSetIds && agent.toolSetIds.length > 0) {
      const tools: Record<string, any> = {};

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
              console.warn(`MCP '${toolSetId}' has no URL configured`);
            }
          } else {
            console.warn(
              `Tool set with id '${toolSetId}' not found as static tool set or MCP`,
            );
          }
        }
      }

      if (Object.keys(tools).length > 0) {
        streamTextParams.tools = tools;
      }
    }

    // Apply agent's configuration parameters
    Object.assign(
      streamTextParams,
      agent.systemPrompt && { system: agent.systemPrompt },
      agent.temperature != null && { temperature: agent.temperature },
      agent.topP != null && { topP: agent.topP },
      agent.topK != null && { topK: agent.topK },
      agent.frequencyPenalty != null && {
        frequencyPenalty: agent.frequencyPenalty,
      },
      agent.presencePenalty != null && {
        presencePenalty: agent.presencePenalty,
      },
    );
  } else {
    // Apply chat-level configuration parameters when no agent is selected
    Object.assign(
      streamTextParams,
      systemPrompt && { system: systemPrompt },
      temperature != null && { temperature },
      topP != null && { topP },
      topK != null && { topK },
      frequencyPenalty != null && { frequencyPenalty },
      presencePenalty != null && { presencePenalty },
    );
  }

  // Stream chat response to client
  const result = streamText(streamTextParams);

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
            console.error("Error closing MCP client:", error);
          }
        }

        // Upsert chat record - try update first, then insert if not found
        const updateResult = await db
          .update(chatTable)
          .set({
            messages,
            agentId: resolvedAgentId || null,
            providerId: resolvedAgentId ? null : resolvedProviderId,
            modelId: resolvedAgentId ? null : resolvedModelId,
            systemPrompt: resolvedAgentId ? null : systemPrompt || null,
            temperature: resolvedAgentId ? null : temperature || null,
            topP: resolvedAgentId ? null : topP || null,
            topK: resolvedAgentId ? null : topK || null,
            seed: resolvedAgentId ? null : seed || null,
            presencePenalty: resolvedAgentId ? null : presencePenalty || null,
            frequencyPenalty: resolvedAgentId ? null : frequencyPenalty || null,
            updatedAt: new Date(),
          })
          .where(
            and(eq(chatTable.id, id), eq(chatTable.workspaceId, workspaceId)),
          )
          .returning();

        // If no rows were updated, insert the record
        if (updateResult.length === 0) {
          await db.insert(chatTable).values({
            id,
            workspaceId,
            title: "Untitled",
            messages,
            agentId: resolvedAgentId || null,
            providerId: resolvedAgentId ? null : resolvedProviderId,
            modelId: resolvedAgentId ? null : resolvedModelId,
            systemPrompt: resolvedAgentId ? null : systemPrompt || null,
            temperature: resolvedAgentId ? null : temperature || null,
            topP: resolvedAgentId ? null : topP || null,
            topK: resolvedAgentId ? null : topK || null,
            seed: resolvedAgentId ? null : seed || null,
            presencePenalty: resolvedAgentId ? null : presencePenalty || null,
            frequencyPenalty: resolvedAgentId ? null : frequencyPenalty || null,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }

        console.log(
          `Successfully upserted chat '${id}' in workspace '${workspaceId}'`,
        );
      } catch (error) {
        console.error(
          `Error upserting chat '${id}' in workspace '${workspaceId}':`,
        );
        console.error(error);
      }
    },
  });
});

chat.delete(
  "/:id",
  sValidator("query", z.object({ workspaceId: z.string() })),
  async (c) => {
    const id = c.req.param("id");
    const { workspaceId } = c.req.valid("query");

    const result = await db
      .delete(chatTable)
      .where(and(eq(chatTable.id, id), eq(chatTable.workspaceId, workspaceId)))
      .returning();

    if (result.length === 0) {
      return c.json({ message: "Chat not found" }, 404);
    }

    return c.json({ message: "Chat deleted successfully" }, 200);
  },
);

chat.put(
  "/:id",
  sValidator("query", z.object({ workspaceId: z.string() })),
  sValidator("json", chatUpdateSchema),
  async (c) => {
    const id = c.req.param("id");
    const { workspaceId } = c.req.valid("query");
    const { title, isStarred, tags } = c.req.valid("json");

    const result = await db
      .update(chatTable)
      .set({ title, isStarred, tags, updatedAt: new Date() })
      .where(and(eq(chatTable.id, id), eq(chatTable.workspaceId, workspaceId)))
      .returning();

    if (result.length === 0) {
      return c.json({ message: "Chat not found" }, 404);
    }

    return c.json(result[0]);
  },
);

chat.post(
  "/:id/generate-metadata",
  sValidator("query", z.object({ workspaceId: z.string() })),
  sValidator("json", chatGenerateMetadataSchema),
  async (c) => {
    const id = c.req.param("id");
    const { workspaceId } = c.req.valid("query");
    const { providerId } = c.req.valid("json");

    // Fetch chat record
    const chatRecord = await db
      .select()
      .from(chatTable)
      .where(and(eq(chatTable.id, id), eq(chatTable.workspaceId, workspaceId)))
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
          eq(providerTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (providerRecord.length === 0) {
      return c.json({ message: "Provider not found" }, 404);
    }
    const provider = providerRecord[0] as Provider;

    // Instantiate model
    let model: LanguageModel = createModel(provider, provider.taskModelId);

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

    const result = await generateObject({
      model,
      schema: z.object({
        title: z.string(),
        tags: z.array(z.string()),
      }),
      prompt: [
        `Generate a short, descriptive title for this chat conversation. You MAY use at most one emoji. The complete title MUST NOT exceed 30 characters.`,
        `Also generate between 1 and 5 kebab-case tags relevant to the chat.`,
        `Each tag should ideally be a single word but no more than two words.`,
        `Conversation:\n${conversationText}`,
      ].join("\n"),
    });

    const newTitle = result.object.title;
    const newTags = result.object.tags;

    // Update chat title and tags
    const updateResult = await db
      .update(chatTable)
      .set({ title: newTitle, tags: newTags, updatedAt: new Date() })
      .where(and(eq(chatTable.id, id), eq(chatTable.workspaceId, workspaceId)))
      .returning();

    return c.json(updateResult[0]);
  },
);

export { chat };
