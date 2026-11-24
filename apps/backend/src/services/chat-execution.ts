import { openProvider, type OpenedProvider } from "./provider.ts";
import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import type { agent as agentTable } from "../db/schema.ts";
import {
  context as contextTable,
  mcp as mcpTable,
  organization as organizationTable,
  sandbox as sandboxTable,
  user as userTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import {
  deferCloserRegistrar,
  openToolSession,
  type ToolSession,
  type ToolSessionQueries,
  type ToolSessionScope,
} from "../tools/tool-session.ts";
import { MEMORY_TOOLSET_ID, SANDBOX_TOOLSET_ID } from "../tools/index.ts";
import {
  createLoadSkillTool,
  createReadSkillFileTool,
} from "../tools/skill.ts";
import {
  LOAD_SKILL_TOOL_NAME,
  READ_SKILL_FILE_TOOL_NAME,
} from "../tools/turn-tool-names.ts";
import {
  createDelegateTools,
  type SubAgentCatalogueEntry,
  type SubAgentFailure,
} from "../tools/sub-agent.ts";
import { normalizeToolResult } from "./tool-result.ts";
import {
  renderSystemPrompt,
  type SystemPromptStableContext,
  type SystemPromptTurnContext,
} from "../system-prompt.ts";
import {
  formatSummariesForSystemPrompt,
  retrieveRecentSummaries,
  type MemorySummary,
} from "./memory-retrieval.ts";
import {
  nextTurnOccupancy,
  occupancyReadingsOf,
  providerHasNativeSearch,
  SEARCH_SOURCE_NATIVE,
  SEARCH_SOURCE_NONE,
} from "@platypus/schemas";
import type {
  ConcreteModelId,
  ContextOccupancyReading,
  Skill,
  UnloadedToolSet,
} from "@platypus/schemas";
import type { ProviderRow } from "./provider-write.ts";
import {
  getWebBackend,
  type WebBackendContext,
} from "../web-backends/index.ts";
import type { WithCoreRegistrar } from "../tools/closers.ts";
import type { Tool } from "ai";
import { logger } from "../logger.ts";
import { inlineFileUrls } from "../storage/utils.ts";
import {
  maxExtractedTextCharsForModel,
  passthroughFileTypesForModel,
} from "./model-capability.ts";
import {
  assertFilePartsSupported,
  messagesHaveFileParts,
  normalizeFileParts,
} from "./file-gate.ts";
import type { PlatypusUIMessage } from "../types.ts";
import { listScopedByIds, resolveScoped } from "./scoped-resource.ts";
import { beforeTurn } from "./chat-summary.ts";
import {
  wrapToolsWithActivity,
  type ToolActivityEvent,
} from "./tool-activity.ts";
import type {
  ParentRunContext,
  ChatTurnRequest,
  FallbackTurn,
  ResolvedGeneration,
  TurnRequest,
} from "../runs/types.ts";
import type { TranscriptSummaryRow } from "@platypus/schemas";
import {
  resolveFallbackGeneration,
  resolveGenerationPlan,
  type FallbackAgentSource,
  type GenerationPlan,
  type GenerationSource,
} from "../runs/agent-plan.ts";
import type { RunPlan } from "../runs/run-plan.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { env } from "../env.ts";

type AgentRow = typeof agentTable.$inferSelect;
type WorkspaceRow = typeof workspaceTable.$inferSelect;
type OrganizationRow = typeof organizationTable.$inferSelect;

type ChatContext = {
  provider: ProviderRow;
  agent?: AgentRow;
  modelReference: string;
  resolvedModelId: ConcreteModelId;
  resolvedProviderId: string;
  resolvedAgentId?: string;
  plan: Omit<RunPlan, "system" | "tools">;
  guardrails: string | null;
  fallback?: GenerationPlan;
};

export type ChatTurn = {
  stream: RunPlan & { messages: PlatypusUIMessage[] };
  resolved: ResolvedGeneration;
  resolvedModelId: ConcreteModelId;
  fallback?: FallbackTurn;
  summaryBackstop?: true;
  searchUnavailable?: boolean;
  unloadedToolSets?: readonly UnloadedToolSet[];
  dispose: () => Promise<void>;
};

const initialOccupancyFrom = (
  readings: readonly (ContextOccupancyReading | null)[],
): number | undefined => nextTurnOccupancy(readings.at(-1));

export type PrepareChatTurnInput = TurnRequest & {
  orgId: string;
  workspaceId: string;
  user: { id: string; name: string };
  sessionId: string;
  chatSummaries?: TranscriptSummaryRow[];
  origin?: string;
  frontendUrl: string;
  runMode: "interactive" | "headless";
  a2aClientName?: string;
  onActivity?: (event: ToolActivityEvent) => void;
  run?: ParentRunContext;
  signal?: AbortSignal;
  fallbackAllowed?: boolean;
};

export type ChatTurnQueries = ToolSessionQueries & {
  getWorkspace(id: string): Promise<WorkspaceRow | null>;
  getOrganization(id: string): Promise<OrganizationRow | null>;
  getAgent(
    id: string,
    orgId: string,
    workspaceId: string,
  ): Promise<AgentRow | null>;
  getProvider(
    id: string,
    orgId: string,
    workspaceId: string,
  ): Promise<ProviderRow | null>;
  getSkillsByIds(
    ids: string[],
    orgId: string,
    workspaceId: string,
  ): Promise<{
    skills: Array<Pick<Skill, "name" | "description">>;
    permittedSkillIds: string[];
  }>;
  getSubAgentsByIds(
    ids: string[],
    orgId: string,
    workspaceId: string,
  ): Promise<AgentRow[]>;
  getUserTimezone(userId: string): Promise<string | null>;
  getUserContexts(
    userId: string,
    workspaceId: string,
  ): Promise<{ global?: string; workspace?: string }>;
  getRecentMemories(
    userId: string,
    workspaceId: string,
    referenceDate: Date,
  ): Promise<MemorySummary[]>;
  getSandboxEnvKeys(workspaceId: string): Promise<string[]>;
};

export const drizzleChatTurnQueries: ChatTurnQueries = {
  async getWorkspace(id) {
    const rows = await db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  async getOrganization(id) {
    const rows = await db
      .select()
      .from(organizationTable)
      .where(eq(organizationTable.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  async getAgent(id, orgId, workspaceId) {
    const found = await resolveScoped(db, "agent", id, {
      orgId,
      workspaceId,
    });
    return found?.row ?? null;
  },

  async getProvider(id, orgId, workspaceId) {
    const found = await resolveScoped(db, "provider", id, {
      orgId,
      workspaceId,
    });
    return found?.row ?? null;
  },

  async getSkillsByIds(ids, orgId, workspaceId) {
    const visible = await listScopedByIds(db, "skill", ids, {
      orgId,
      workspaceId,
    });

    const permittedSkillIds = visible.map(({ row }) => row.id);

    const workspaceSkills = visible.filter((s) => s.scope === "workspace");
    const seen = new Set(workspaceSkills.map(({ row }) => row.name));
    const skills = [
      ...workspaceSkills,
      ...visible.filter(
        (s) => s.scope === "organization" && !seen.has(s.row.name),
      ),
    ]
      .filter(({ row }) => !row.disableModelInvocation)
      .map(({ row }) => ({ name: row.name, description: row.description }));

    return { skills, permittedSkillIds };
  },

  async getMcp(id, orgId, workspaceId) {
    const found = await resolveScoped(db, "mcp", id, {
      orgId,
      workspaceId,
    });
    return found?.row ?? null;
  },

  async saveMcpToolListing(id, listing, fetchedAt) {
    await db
      .update(mcpTable)
      .set({
        lastKnownToolListing: listing,
        lastKnownToolListingFetchedAt: fetchedAt,
      })
      .where(eq(mcpTable.id, id));
  },

  async setMcpFetchFailedAt(id, failedAt) {
    await db
      .update(mcpTable)
      .set({ lastFetchFailedAt: failedAt })
      .where(eq(mcpTable.id, id));
  },

  async getSubAgentsByIds(ids, orgId, workspaceId) {
    const visible = await listScopedByIds(db, "agent", ids, {
      orgId,
      workspaceId,
    });

    const byId = new Map(visible.map(({ row }) => [row.id, row]));
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is AgentRow => row !== undefined);
  },

  async getUserTimezone(userId) {
    const rows = await db
      .select({ timezone: userTable.timezone })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);
    return rows[0]?.timezone ?? null;
  },

  async getUserContexts(userId, workspaceId) {
    const rows = await db
      .select({
        content: contextTable.content,
        workspaceId: contextTable.workspaceId,
      })
      .from(contextTable)
      .where(eq(contextTable.userId, userId));

    let global: string | undefined;
    let workspace: string | undefined;
    for (const ctx of rows) {
      if (ctx.workspaceId === null) global = ctx.content;
      else if (ctx.workspaceId === workspaceId) workspace = ctx.content;
    }
    return { global, workspace };
  },

  async getRecentMemories(userId, workspaceId, referenceDate) {
    return retrieveRecentSummaries(userId, workspaceId, referenceDate);
  },

  async getSandboxEnvKeys(workspaceId) {
    const [row] = await db
      .select({
        adminEnv: sandboxTable.adminEnv,
        userEnv: sandboxTable.userEnv,
      })
      .from(sandboxTable)
      .where(eq(sandboxTable.workspaceId, workspaceId))
      .limit(1);
    if (!row) return [];
    return Object.keys({ ...row.userEnv, ...row.adminEnv });
  },
};

export type SearchResolution =
  { kind: "none" } | { kind: "native" } | { kind: "backend"; backend: string };

export const resolveSearchMode = (
  requestedSearch: boolean | undefined,
  provider: Pick<ProviderRow, "providerType" | "apiMode" | "searchSource">,
): SearchResolution => {
  if (!requestedSearch) return { kind: "none" };
  const source = provider.searchSource;
  if (!source || source === SEARCH_SOURCE_NONE) return { kind: "none" };
  if (source !== SEARCH_SOURCE_NATIVE) {
    return { kind: "backend", backend: source };
  }
  if (providerHasNativeSearch(provider)) return { kind: "native" };
  return { kind: "none" };
};

const resolveSearchTools = async (
  resolution: SearchResolution,
  opened: Pick<OpenedProvider, "searchTools">,
  provider: Pick<ProviderRow, "id">,
  ctx: WithCoreRegistrar<WebBackendContext>,
  signal: AbortSignal | undefined,
): Promise<Record<string, Tool>> => {
  const turnCtx = { ...ctx, providerId: provider.id };

  if (resolution.kind === "none") return {};
  if (resolution.kind === "native") return opened.searchTools?.() ?? {};

  const registration = getWebBackend(resolution.backend);
  if (!registration) {
    logger.warn(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        providerId: provider.id,
        searchSource: resolution.backend,
      },
      "provider.searchSource references an unregistered web backend; serving no search tools this turn",
    );
    return {};
  }
  return registration.buildTurnTools(turnCtx, signal);
};

export const prepareChatTurn = async (
  input: PrepareChatTurnInput,
  queries: ChatTurnQueries,
): Promise<ChatTurn> => {
  const {
    orgId,
    workspaceId,
    user,
    request,
    messages,
    chatSummaries,
    origin,
    frontendUrl,
    runMode,
    a2aClientName,
    onActivity,
    run,
    signal,
    fallbackAllowed = false,
  } = input;

  const workspace = await queries.getWorkspace(workspaceId);
  if (!workspace) {
    throw new NotFoundError(`Workspace '${workspaceId}' not found`);
  }

  // why: org identity is framing only; a missing org row must not fail the turn
  const [organization, profileTimezone] = await Promise.all([
    queries.getOrganization(orgId),
    queries.getUserTimezone(user.id),
  ]);

  const context = await resolveChatContext(
    queries,
    request,
    orgId,
    workspaceId,
    input.sessionId,
    fallbackAllowed,
  );
  const { provider, agent, resolvedModelId } = context;

  const opened = openProvider(provider, { sessionId: input.sessionId });

  const scope: ToolSessionScope = {
    orgId,
    workspaceId,
    userId: user.id,
    frontendUrl,
    sessionId: input.sessionId,
    // why: Tools need a zone; the prompt states only the profile's
    timezone: profileTimezone ?? env().TIMEZONE,
  };
  // why: withheld at the session, so a nested delegate session is withheld them too
  // why: opened here, before Promise.all; delegates built in it take the promise, not the session
  const memoryTools = input.memoryTools;
  const sessionPromise = openToolSession(scope, agent, queries, {
    signal,
    withheldToolSetIds: memoryTools ? [] : [MEMORY_TOOLSET_ID],
    interactive: runMode === "interactive",
  });
  // why: try starts here; a Promise.all rejection would leave the session resolving unowned
  try {
    const registerCloser = deferCloserRegistrar(sessionPromise);

    const searchResolution = resolveSearchMode(request.search, provider);

    const includeMemories = input.includeMemories;

    const [
      session,
      { skills, permittedSkillIds },
      { subAgents, unavailableSubAgents, subAgentTools },
      userContexts,
      memories,
      sandboxEnvKeys,
      searchTools,
    ] = await Promise.all([
      sessionPromise,
      loadSkills(queries, agent, orgId, workspaceId),
      loadSubAgents(
        queries,
        agent,
        scope,
        sessionPromise,
        run,
        fallbackAllowed,
      ),
      queries.getUserContexts(user.id, workspaceId),
      resolveMemories(
        queries,
        user.id,
        workspaceId,
        input.memorySnapshot,
        input.memoriesReferenceDate,
        includeMemories,
      ),
      queries.getSandboxEnvKeys(workspaceId),
      resolveSearchTools(
        searchResolution,
        opened,
        provider,
        {
          orgId,
          workspaceId,
          userId: user.id,
          registerCloser,
        },
        signal,
      ),
    ]);

    // why: a cancelled turn serves none because it is torn down, not because search was unavailable
    const searchUnavailable =
      !signal?.aborted &&
      searchResolution.kind !== "none" &&
      Object.keys(searchTools).length === 0;

    // why: order is precedence: search beats session tools, sub-agent tools beat search
    const tools: Record<string, Tool> = { ...session.tools };
    Object.assign(tools, searchTools);
    Object.assign(tools, subAgentTools);

    const turn: SystemPromptTurnContext = { memories };

    const stable: SystemPromptStableContext = {
      workspace: { id: workspaceId, context: workspace.context ?? undefined },
      agent:
        agent && !memoryTools
          ? {
              ...agent,
              toolSetIds: agent.toolSetIds.filter(
                (id) => id !== MEMORY_TOOLSET_ID,
              ),
            }
          : (agent ?? null),
      user: {
        id: user.id,
        name: user.name,
        globalContext: userContexts.global,
        workspaceContext: userContexts.workspace,
        timezone: profileTimezone ?? undefined,
      },
      memoriesBlock: includeMemories
        ? (input.memorySnapshot ??
          formatSummariesForSystemPrompt(turn.memories))
        : "",
      memorySearchAvailable: Object.hasOwn(tools, "memorySearch"),
      fsDownloadAvailable: Object.hasOwn(tools, "fsDownload"),
      skills,
      subAgents,
      unavailableSubAgents,
      sandboxEnvKeys,
      fallbackInstructions: request.instructions,
      runMode,
      a2aClientName,
      securityGuardrails: context.guardrails,
      organizationIdentityContext: organization?.identityContext,
    };

    const systemPrompt = renderSystemPrompt(stable);
    const fallbackSystem = context.fallback
      ? renderSystemPrompt({
          ...stable,
          securityGuardrails: context.fallback.guardrails,
        })
      : undefined;

    if (permittedSkillIds.length > 0) {
      tools[LOAD_SKILL_TOOL_NAME] = createLoadSkillTool(
        orgId,
        workspaceId,
        permittedSkillIds,
        agent?.toolSetIds.includes(SANDBOX_TOOLSET_ID) ?? false,
      );
      tools[READ_SKILL_FILE_TOOL_NAME] = createReadSkillFileTool(
        orgId,
        workspaceId,
        permittedSkillIds,
      );
    }

    const wrappedTools = onActivity
      ? wrapToolsWithActivity(tools, onActivity)
      : tools;

    // why: summary applied before file inlining, so files it covers are not fetched
    const summaryRead = await beforeTurn({
      chatId: run?.runId,
      path: messages,
      summaries: chatSummaries ?? [],
      contextWindow: context.plan.contextWindow,
      model: context.plan.model,
      modelId: context.resolvedModelId,
      outputCeiling: context.plan.maxOutputTokens,
      taskModel: {
        scope: { orgId, workspaceId },
        providerId: context.resolvedProviderId,
      },
      readOnlyToolNames: session.readOnlyToolNames,
      signal,
    });

    const messagesToSend = summaryRead.messages;
    const passthroughFileTypes = passthroughFileTypesForModel(
      provider,
      resolvedModelId,
    );
    const inlinedMessages = await normalizeFileParts(
      origin && run
        ? await inlineFileUrls(messagesToSend, origin, {
            orgId,
            workspaceId,
            // why: a Chat run's id is its Chat's id, the prefix ChatSink stored files under
            chatId: run.runId,
          })
        : messagesToSend,
      passthroughFileTypes,
      {
        maxExtractedTextChars: maxExtractedTextCharsForModel(
          provider,
          resolvedModelId,
        ),
      },
    );

    // why: the full path, not messagesToSend; covered readings keep clearing engaged
    const priorOccupancyReadings = occupancyReadingsOf(messages);
    const initialOccupancy = initialOccupancyFrom(priorOccupancyReadings);

    return {
      stream: {
        ...context.plan,
        tools: wrappedTools,
        system: systemPrompt,
        messages: inlinedMessages,
        ...(summaryRead.summaryId ? { summaryId: summaryRead.summaryId } : {}),
        readOnlyToolNames: session.readOnlyToolNames,
        gateScope: session.gateScope,
        ...(initialOccupancy !== undefined ? { initialOccupancy } : {}),
        ...(priorOccupancyReadings.length > 0
          ? { priorOccupancyReadings }
          : {}),
      },
      resolved: {
        agentId: context.resolvedAgentId,
        providerId: context.resolvedProviderId,
        modelId: context.modelReference,
        // why: the user's own instructions, never the composite; it backs an editable box
        instructions: agent ? undefined : request.instructions,
        temperature: agent ? undefined : context.plan.temperature,
        topP: agent ? undefined : context.plan.topP,
        topK: agent ? undefined : context.plan.topK,
        frequencyPenalty: agent ? undefined : context.plan.frequencyPenalty,
        presencePenalty: agent ? undefined : context.plan.presencePenalty,
        seed: agent ? undefined : context.plan.seed,
        reasoningThinking: agent
          ? undefined
          : (request.reasoningThinking ?? undefined),
        reasoningEffort: agent
          ? undefined
          : (request.reasoningEffort ?? undefined),
        thinkingBudget: agent
          ? undefined
          : (request.thinkingBudget ?? undefined),
        // why: the requested value, not the plan's resolved ceiling
        maxSteps: agent ? undefined : (request.maxSteps ?? undefined),
      },
      resolvedModelId: context.resolvedModelId,
      searchUnavailable,
      ...(context.fallback && fallbackSystem !== undefined
        ? {
            fallback: {
              plan: context.fallback.plan,
              system: fallbackSystem,
            },
          }
        : {}),
      unloadedToolSets: session.unloadedToolSets,
      ...(summaryRead.backstopEngaged
        ? { summaryBackstop: true as const }
        : {}),
      dispose: session.dispose,
    };
  } catch (error) {
    await sessionPromise.then((session) => session.dispose()).catch(() => {});
    throw error;
  }
};

export const validateTurnAttachments = async (
  args: Pick<TurnRequest, "request" | "messages"> & {
    orgId: string;
    workspaceId: string;
    sessionId: string;
  },
  queries: ChatTurnQueries,
): Promise<void> => {
  if (!messagesHaveFileParts(args.messages)) return;

  let passthroughFileTypes: string[];
  try {
    const context = await resolveChatContext(
      queries,
      args.request,
      args.orgId,
      args.workspaceId,
      args.sessionId,
      false,
    );
    passthroughFileTypes = passthroughFileTypesForModel(
      context.provider,
      context.resolvedModelId,
    );
  } catch {
    return;
  }

  await assertFilePartsSupported(args.messages, passthroughFileTypes);
};

const resolveMemories = async (
  queries: ChatTurnQueries,
  userId: string,
  workspaceId: string,
  memorySnapshot: string | undefined,
  referenceDate: Date,
  includeMemories: boolean,
): Promise<MemorySummary[]> => {
  if (memorySnapshot !== undefined) return [];
  if (!includeMemories) return [];
  return queries.getRecentMemories(userId, workspaceId, referenceDate);
};

export { normalizeToolResult };
export { wrapToolsWithActivity, type ToolActivityEvent };

const resolveFallbackOrLog = async (
  agent: FallbackAgentSource & { id: string },
  scope: { orgId: string; workspaceId: string; sessionId: string },
  queries: ChatTurnQueries,
  message: string,
): Promise<GenerationPlan | undefined> => {
  try {
    return await resolveFallbackGeneration(agent, scope, queries);
  } catch (error) {
    logger.warn(
      {
        agentId: agent.id,
        fallbackProviderId: agent.fallbackProviderId,
        fallbackModelId: agent.fallbackModelId,
        error,
      },
      message,
    );
    return undefined;
  }
};

const resolveChatContext = async (
  queries: ChatTurnQueries,
  data: ChatTurnRequest,
  orgId: string,
  workspaceId: string,
  sessionId: string,
  fallbackAllowed: boolean,
): Promise<ChatContext> => {
  const { agentId, providerId, modelId } = data;

  let resolvedAgentId: string | undefined;
  let agent: AgentRow | undefined;
  let source: GenerationSource;

  if (agentId) {
    resolvedAgentId = agentId;
    const found = await queries.getAgent(agentId, orgId, workspaceId);
    if (!found) throw new NotFoundError(`Agent '${agentId}' not found`);
    agent = found;
    source = { agent: found };
  } else if (providerId && modelId) {
    source = {
      providerId,
      modelId,
      temperature: data.temperature,
      topP: data.topP,
      topK: data.topK,
      seed: data.seed,
      presencePenalty: data.presencePenalty,
      frequencyPenalty: data.frequencyPenalty,
      reasoningThinking: data.reasoningThinking,
      reasoningEffort: data.reasoningEffort,
      thinkingBudget: data.thinkingBudget,
      maxSteps: data.maxSteps,
    };
  } else {
    throw new ValidationError(
      "Must provide either agentId or (providerId and modelId)",
    );
  }

  const { plan, provider, resolvedModelId, modelReference, guardrails } =
    await resolveGenerationPlan(
      source,
      { orgId, workspaceId, sessionId },
      queries,
    );

  let fallback: GenerationPlan | undefined;
  if (fallbackAllowed && agent) {
    fallback = await resolveFallbackOrLog(
      agent,
      { orgId, workspaceId, sessionId },
      queries,
      "Fallback model did not resolve; the run will use the primary only",
    );
  }

  return {
    provider,
    agent,
    modelReference,
    resolvedModelId,
    resolvedProviderId: provider.id,
    resolvedAgentId,
    plan,
    guardrails,
    ...(fallback ? { fallback } : {}),
  };
};

const loadSkills = async (
  queries: ChatTurnQueries,
  agent: AgentRow | undefined,
  orgId: string,
  workspaceId: string,
): Promise<{
  skills: Array<Pick<Skill, "name" | "description">>;
  permittedSkillIds: string[];
}> => {
  if (!agent || agent.skillIds.length === 0) {
    return { skills: [], permittedSkillIds: [] };
  }
  return queries.getSkillsByIds(agent.skillIds, orgId, workspaceId);
};

const UNRESOLVED_SUB_AGENT_REASON =
  "not available in this workspace — it may have been deleted, or it is a shared agent that is not attached here";

const loadSubAgents = async (
  queries: ChatTurnQueries,
  agent: AgentRow | undefined,
  scope: ToolSessionScope,
  session: Promise<ToolSession>,
  run: ParentRunContext | undefined,
  fallbackAllowed: boolean,
): Promise<{
  subAgents: SubAgentCatalogueEntry[];
  unavailableSubAgents: SubAgentFailure[];
  subAgentTools: Record<string, Tool>;
}> => {
  if (!agent || agent.subAgentIds.length === 0) {
    return {
      subAgents: [],
      unavailableSubAgents: [],
      subAgentTools: {},
    };
  }

  const { orgId, workspaceId, sessionId } = scope;
  const assignedIds = [...new Set(agent.subAgentIds)];
  const subAgentRecords = await queries.getSubAgentsByIds(
    assignedIds,
    orgId,
    workspaceId,
  );

  // why: by id alone; reading a name off an unattached Agent's row crosses the boundary
  const resolvedIds = new Set(subAgentRecords.map((sa) => sa.id));
  const unresolved: SubAgentFailure[] = assignedIds
    .filter((id) => !resolvedIds.has(id))
    .map((id) => ({ id, reason: UNRESOLVED_SUB_AGENT_REASON }));

  const {
    tools: subAgentTools,
    catalogue,
    failures,
  } = await createDelegateTools(
    subAgentRecords,
    async (subAgent) => {
      const resolved = await resolveGenerationPlan(
        { agent: subAgent },
        { orgId, workspaceId, sessionId },
        queries,
      );
      if (!fallbackAllowed) return resolved;
      const fallback = await resolveFallbackOrLog(
        subAgent,
        { orgId, workspaceId, sessionId },
        queries,
        "Sub-Agent fallback model did not resolve; its run will use the primary only",
      );
      return fallback ? { ...resolved, fallback } : resolved;
    },
    async (subAgentId: string, toolSetIds: string[]) => {
      const parent = await session;
      const nested = await parent.nest({ id: subAgentId, toolSetIds });
      return {
        tools: nested.tools,
        readOnlyToolNames: nested.readOnlyToolNames,
        gateScope: nested.gateScope,
      };
    },
    run,
    unresolved,
  );

  return {
    subAgents: catalogue,
    unavailableSubAgents: failures,
    subAgentTools,
  };
};
