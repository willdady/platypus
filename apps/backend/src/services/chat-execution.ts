import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic, type AnthropicProvider } from "@ai-sdk/anthropic";
import {
  createGoogleGenerativeAI,
  type GoogleGenerativeAIProvider,
} from "@ai-sdk/google";
import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { and, eq, or, inArray } from "drizzle-orm";
import { db } from "../index.ts";
import {
  agent as agentTable,
  mcp as mcpTable,
  provider as providerTable,
  skill as skillTable,
} from "../db/schema.ts";
import { getToolSet } from "../tools/index.ts";
import { createLoadSkillTool } from "../tools/skill.ts";
import { createSubAgentTools } from "../tools/sub-agent.ts";
import { renderSystemPrompt } from "../system-prompt.ts";
import {
  retrieveUserLevelMemories,
  retrieveWorkspaceLevelMemories,
  formatMemoriesForSystemPrompt,
} from "./memory-retrieval.ts";
import type { Provider, Skill } from "@platypus/schemas";
import type { Tool } from "ai";
import { logger } from "../logger.ts";

// --- Types ---

export type ChatContext = {
  provider: Provider;
  agent?: typeof agentTable.$inferSelect;
  resolvedModelId: string;
  resolvedProviderId: string;
  resolvedAgentId?: string;
  resolvedMaxSteps: number;
};

export type GenerationConfig = {
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  skills?: Array<Pick<Skill, "name" | "description">>;
};

export type ChatSubmitData = {
  agentId?: string;
  providerId?: string;
  modelId?: string;
  search?: boolean;
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
};

// --- Helper Functions ---

/**
 * Creates a LanguageModel instance based on the provider configuration.
 */
export const createModel = (provider: Provider, modelId: string) => {
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
export const resolveChatContext = async (
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
export const loadTools = async (
  agent: typeof agentTable.$inferSelect | undefined,
  workspaceId: string,
): Promise<{ tools: Record<string, Tool>; mcpClients: any[] }> => {
  const tools: Record<string, Tool> = {};
  const mcpClients: any[] = [];

  if (!agent || !agent.toolSetIds || agent.toolSetIds.length === 0) {
    return { tools, mcpClients };
  }

  for (const toolSetId of agent.toolSetIds) {
    // Special handling for dynamic tool sets
    if (toolSetId === "kanban") {
      const { createKanbanTools } = await import("../tools/kanban.ts");
      const kanbanTools = createKanbanTools(
        workspaceId,
        agent.id,
      );
      Object.assign(tools, kanbanTools);
      continue;
    }

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
export const createSearchTools = (
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
export const resolveGenerationConfig = async (
  data: ChatSubmitData,
  workspaceId: string,
  agent: typeof agentTable.$inferSelect | undefined = undefined,
  workspaceContext: string | undefined = undefined,
  skills: Array<Pick<Skill, "name" | "description">> | undefined = undefined,
  user: { id: string; name: string },
  userGlobalContext?: string,
  userWorkspaceContext?: string,
  subAgents?: Array<{ id: string; name: string; description?: string | null }>,
  memoriesFormatted?: string,
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

  const systemPrompt = renderSystemPrompt({
    workspaceId,
    workspaceContext,
    agentSystemPrompt,
    skills,
    user,
    userGlobalContext,
    userWorkspaceContext,
    subAgents: subAgents?.map((sa) => ({
      ...sa,
      description: sa.description || undefined,
    })),
    memoriesFormatted,
  });

  config.systemPrompt = systemPrompt;
  return config;
};

/**
 * Loads skills for an agent.
 */
export const loadSkills = async (
  agent: typeof agentTable.$inferSelect | undefined,
  workspaceId: string,
): Promise<Array<Pick<Skill, "name" | "description">>> => {
  if (!agent?.skillIds || agent.skillIds.length === 0) {
    return [];
  }

  const skillRecords = await db
    .select({ name: skillTable.name, description: skillTable.description })
    .from(skillTable)
    .where(
      and(
        eq(skillTable.workspaceId, workspaceId),
        inArray(skillTable.id, agent.skillIds),
      ),
    );

  return skillRecords;
};

/**
 * Loads sub-agent details and creates delegate tools.
 */
export const loadSubAgents = async (
  agent: typeof agentTable.$inferSelect | undefined,
  orgId: string,
  workspaceId: string,
): Promise<{
  subAgents: Array<{ id: string; name: string; description?: string | null }>;
  subAgentTools: Record<string, Tool>;
}> => {
  if (!agent?.subAgentIds || agent.subAgentIds.length === 0) {
    return { subAgents: [], subAgentTools: {} };
  }

  // Fetch full sub-agent configs including provider/model/tool info
  const subAgentRecords = await db
    .select()
    .from(agentTable)
    .where(inArray(agentTable.id, agent.subAgentIds));

  const subAgents = subAgentRecords.map((sa) => ({
    id: sa.id,
    name: sa.name,
    description: sa.description,
  }));

  // Create sub-agent tools with their own models and tools
  const subAgentTools = await createSubAgentTools(
    subAgentRecords,
    async (providerId: string, modelId: string) => {
      // Resolve provider for the sub-agent
      const subProviderRecord = await db
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

      if (subProviderRecord.length === 0) {
        throw new Error(`Provider '${providerId}' not found for sub-agent`);
      }

      const [, model] = createModel(subProviderRecord[0] as Provider, modelId);
      return model;
    },
    async (subAgentId: string, toolSetIds: string[]) => {
      // Load tools for the sub-agent, passing the full record so dynamic
      // tool sets (e.g. kanban) can resolve the correct agent ID.
      const subAgentRecord = subAgentRecords.find(
        (sa) => sa.id === subAgentId,
      );
      const { tools: subTools } = await loadTools(
        subAgentRecord ?? ({ id: subAgentId, toolSetIds } as any),
        workspaceId,
      );
      return subTools;
    },
  );

  return { subAgents, subAgentTools };
};

/**
 * Fetches user contexts (global and workspace-specific).
 */
export const fetchUserContexts = async (
  userId: string,
  workspaceId: string,
): Promise<{ userGlobalContext?: string; userWorkspaceContext?: string }> => {
  const { context: contextTable } = await import("../db/schema.ts");

  let userGlobalContext: string | undefined;
  let userWorkspaceContext: string | undefined;

  const userContexts = await db
    .select({
      content: contextTable.content,
      workspaceId: contextTable.workspaceId,
    })
    .from(contextTable)
    .where(eq(contextTable.userId, userId));

  for (const ctx of userContexts) {
    if (ctx.workspaceId === null) {
      userGlobalContext = ctx.content;
    } else if (ctx.workspaceId === workspaceId) {
      userWorkspaceContext = ctx.content;
    }
  }

  return { userGlobalContext, userWorkspaceContext };
};

/**
 * Fetches and formats memories for the user.
 */
export const fetchFormattedMemories = async (
  userId: string,
  workspaceId: string,
): Promise<string | undefined> => {
  const [userLevelMemories, workspaceLevelMemories] = await Promise.all([
    retrieveUserLevelMemories(userId),
    retrieveWorkspaceLevelMemories(userId, workspaceId),
  ]);
  const memories = [...userLevelMemories, ...workspaceLevelMemories];
  return formatMemoriesForSystemPrompt(memories);
};

/**
 * Prepares tools for an agent execution.
 */
export const prepareAgentTools = (
  tools: Record<string, Tool>,
  skills: Array<Pick<Skill, "name" | "description">>,
  workspaceId: string,
): void => {
  // Inject loadSkill tool if skills exist
  if (skills.length > 0) {
    tools.loadSkill = createLoadSkillTool(workspaceId);
  }
};
