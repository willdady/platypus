import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { openProvider } from "./provider.ts";
import { and, eq, or, inArray } from "drizzle-orm";
import { db } from "../index.ts";
import {
  agent as agentTable,
  context as contextTable,
  mcp as mcpTable,
  provider as providerTable,
  sandbox as sandboxTable,
  skill as skillTable,
  workspace as workspaceTable,
  attachment as attachmentTable,
} from "../db/schema.ts";
import { getToolSet } from "../tools/index.ts";
import { createLoadSkillTool } from "../tools/skill.ts";
import { createSubAgentTools } from "../tools/sub-agent.ts";
import {
  renderSystemPrompt,
  type SystemPromptContext,
} from "../system-prompt.ts";
import {
  retrieveRecentSummaries,
  type MemorySummary,
} from "./memory-retrieval.ts";
import type { Provider, Skill } from "@platypus/schemas";
import type { Tool } from "ai";
import { logger } from "../logger.ts";
import { buildMcpTransportConfig } from "./mcp-oauth-provider.ts";
import { inlineFileUrls } from "../storage/utils.ts";
import type { PlatypusUIMessage } from "../types.ts";

// --- Errors ---

/**
 * Thrown when the caller's request is malformed or references resources in an
 * inconsistent way (e.g. a model id not enabled on the chosen provider).
 * The route maps this to a 400 response.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Thrown when a referenced record does not exist (Agent, Provider, Workspace).
 * The route maps this to a 404 response.
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

// --- Types ---

type AgentRow = typeof agentTable.$inferSelect;
type WorkspaceRow = typeof workspaceTable.$inferSelect;
type McpRow = typeof mcpTable.$inferSelect;

type ChatContext = {
  provider: Provider;
  agent?: AgentRow;
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

/**
 * The slim request shape `prepareChatTurn` actually consumes: agent/provider
 * selection plus generation overrides. Distinct from `@platypus/schemas`'
 * `ChatSubmitData` (the HTTP payload, which also carries id/workspaceId/
 * messages) — those arrive as separate `PrepareChatTurnInput` fields.
 */
export type ChatTurnRequest = {
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

export type ChatTurn = {
  stream: {
    model: any;
    tools: Record<string, Tool>;
    system: string;
    messages: PlatypusUIMessage[];
    maxSteps: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    seed?: number;
  };
  resolved: {
    agentId?: string;
    providerId: string;
    modelId: string;
    systemPrompt?: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    seed?: number;
  };
  dispose: () => Promise<void>;
};

export type PrepareChatTurnInput = {
  orgId: string;
  workspaceId: string;
  user: { id: string; name: string };
  request: ChatTurnRequest;
  messages: PlatypusUIMessage[];
  /**
   * Used to rewrite `storage://` URLs in messages to absolute HTTP URLs so
   * the model can fetch them. Optional for headless callers (triggers,
   * sub-agents) whose messages contain no file references.
   */
  origin?: string;
  frontendUrl?: string;
  /**
   * Defaults to "interactive" when omitted. Headless callers (triggers,
   * sub-agents) must pass "headless" so the system prompt reframes the
   * user line and surfaces the agent's own identity.
   */
  runMode?: "interactive" | "headless";
  /**
   * Called whenever a tool call begins, completes, or yields activity.
   * The agent runner uses this to reset the per-step timeout so long-running
   * tool calls (e.g. MCP web search, sub-agent delegation) don't trip the
   * stall detector while work is actively in progress. The optional `event`
   * carries tool-call boundary metadata that the runner logs; sub-agent
   * yield bumps invoke with no event (timer-only).
   */
  onActivity?: (event?: ToolActivityEvent) => void;
};

/**
 * Per-tool-call lifecycle event surfaced to the agent runner so it can log
 * tool start/end with duration. `durationMs` is only set on `"end"` events.
 */
export type ToolActivityEvent = {
  phase: "start" | "end";
  toolName: string;
  durationMs?: number;
};

// --- Queries seam ---

/**
 * The data-access surface `prepareChatTurn` depends on. Production wires this
 * to Drizzle (`drizzleChatTurnQueries`); tests pass an in-memory implementation
 * from `chat-execution.test-fixtures.ts`. Methods are named after domain
 * lookups, not query shapes — callers don't compose `where`/`limit` chains.
 */
export type ChatTurnQueries = {
  getWorkspace(id: string): Promise<WorkspaceRow | null>;
  getAgent(
    id: string,
    orgId: string,
    workspaceId: string,
  ): Promise<AgentRow | null>;
  getProvider(
    id: string,
    orgId: string,
    workspaceId: string,
  ): Promise<Provider | null>;
  getSkillsByIds(
    ids: string[],
    orgId: string,
    workspaceId: string,
  ): Promise<Array<Pick<Skill, "name" | "description">>>;
  getMcp(
    id: string,
    orgId: string,
    workspaceId: string,
  ): Promise<McpRow | null>;
  getSubAgentsByIds(ids: string[]): Promise<AgentRow[]>;
  getUserContexts(
    userId: string,
    workspaceId: string,
  ): Promise<{ global?: string; workspace?: string }>;
  getRecentMemories(
    userId: string,
    workspaceId: string,
  ): Promise<MemorySummary[]>;
  /**
   * Returns the *keys* of the workspace's sandbox env vars (values omitted —
   * see ADR-0004). Empty array if no sandbox is configured or env is empty.
   */
  getSandboxEnvKeys(workspaceId: string): Promise<string[]>;
};

/**
 * Whether an org-scoped Shared resource is attached to the given workspace
 * (ADR-0007). Org-scoped resources resolve at Chat-turn time only where attached.
 */
const isAttached = async (
  resourceType: "mcp" | "provider" | "skill" | "agent",
  resourceId: string,
  workspaceId: string,
): Promise<boolean> => {
  const rows = await db
    .select()
    .from(attachmentTable)
    .where(
      and(
        eq(attachmentTable.workspaceId, workspaceId),
        eq(attachmentTable.resourceType, resourceType),
        eq(attachmentTable.resourceId, resourceId),
      ),
    )
    .limit(1);
  return rows.length > 0;
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

  async getAgent(id, orgId, workspaceId) {
    // Resolve an Agent at either scope: the invoking workspace, or the
    // organization (a Shared Agent — ADR-0007).
    const rows = await db
      .select()
      .from(agentTable)
      .where(
        and(
          eq(agentTable.id, id),
          or(
            eq(agentTable.workspaceId, workspaceId),
            eq(agentTable.organizationId, orgId),
          ),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // A Shared Agent runs only in a Workspace it is attached to (ADR-0007); its
    // Sandbox/MCP tools still rebind to that invoking Workspace via loadTools.
    if (
      row.organizationId &&
      !row.workspaceId &&
      !(await isAttached("agent", id, workspaceId))
    ) {
      return null;
    }
    return row;
  },

  async getProvider(id, orgId, workspaceId) {
    const rows = await db
      .select()
      .from(providerTable)
      .where(
        and(
          eq(providerTable.id, id),
          or(
            eq(providerTable.workspaceId, workspaceId),
            eq(providerTable.organizationId, orgId),
          ),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // An org-scoped (Shared) Provider resolves only where attached (ADR-0007).
    if (
      row.organizationId &&
      !row.workspaceId &&
      !(await isAttached("provider", id, workspaceId))
    ) {
      return null;
    }
    return row as Provider;
  },

  async getSkillsByIds(ids, orgId, workspaceId) {
    if (ids.length === 0) return [];
    // Workspace-scoped Skills referenced by the Agent.
    const workspaceSkills = await db
      .select({ name: skillTable.name, description: skillTable.description })
      .from(skillTable)
      .where(
        and(
          eq(skillTable.workspaceId, workspaceId),
          inArray(skillTable.id, ids),
        ),
      );

    // Org-scoped (Shared) Skills resolve only where attached (ADR-0007) — gate
    // by an inner join on the Attachment table for the invoking workspace.
    const orgSkills = await db
      .select({ name: skillTable.name, description: skillTable.description })
      .from(skillTable)
      .innerJoin(
        attachmentTable,
        and(
          eq(attachmentTable.resourceId, skillTable.id),
          eq(attachmentTable.resourceType, "skill"),
          eq(attachmentTable.workspaceId, workspaceId),
        ),
      )
      .where(
        and(eq(skillTable.organizationId, orgId), inArray(skillTable.id, ids)),
      );

    // A workspace-scoped Skill wins a name collision with an attached org-scoped
    // one, matching loadSkill's workspace-first resolution — so the advertised
    // list and the tool agree on which body the model loads, with no duplicate
    // entry in the system prompt.
    const seen = new Set(workspaceSkills.map((s) => s.name));
    return [...workspaceSkills, ...orgSkills.filter((s) => !seen.has(s.name))];
  },

  async getMcp(id, orgId, workspaceId) {
    // Resolve an MCP referenced by an Agent's tool sets at either scope: the
    // invoking workspace, or the organization (a Shared MCP — ADR-0007).
    const rows = await db
      .select()
      .from(mcpTable)
      .where(
        and(
          eq(mcpTable.id, id),
          or(
            eq(mcpTable.workspaceId, workspaceId),
            eq(mcpTable.organizationId, orgId),
          ),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // An org-scoped (Shared) MCP resolves only where attached (ADR-0007).
    if (
      row.organizationId &&
      !row.workspaceId &&
      !(await isAttached("mcp", id, workspaceId))
    ) {
      return null;
    }
    return row;
  },

  async getSubAgentsByIds(ids) {
    if (ids.length === 0) return [];
    return db.select().from(agentTable).where(inArray(agentTable.id, ids));
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

  async getRecentMemories(userId, workspaceId) {
    return retrieveRecentSummaries(userId, workspaceId);
  },

  async getSandboxEnvKeys(workspaceId) {
    const rows = await db
      .select({
        adminEnv: sandboxTable.adminEnv,
        userEnv: sandboxTable.userEnv,
      })
      .from(sandboxTable)
      .where(eq(sandboxTable.workspaceId, workspaceId))
      .limit(1);
    if (rows.length === 0) return [];
    // Union of both tiers; the orientation block lists keys only (ADR-0004).
    return Object.keys({ ...rows[0].userEnv, ...rows[0].adminEnv });
  },
};

/**
 * Whether the provider's native web_search tool should be injected for this
 * turn. True only when the request opted into search AND the provider hasn't
 * disabled native search. This is the authority over the chat search toggle:
 * it covers both the raw-model and agent paths and ignores a stale client that
 * still sends `search: true` for a provider whose native search was turned off
 * (#167). `nativeSearchEnabled` is undefined for legacy provider rows, which is
 * treated as enabled.
 */
export const shouldInjectNativeSearch = (
  requestedSearch: boolean | undefined,
  provider: Pick<Provider, "nativeSearchEnabled">,
): boolean =>
  Boolean(requestedSearch) && provider.nativeSearchEnabled !== false;

// --- Public Module: prepare a Chat turn ---

/**
 * Prepares everything required to run a Chat turn: resolves the Agent and
 * Provider, builds the model, loads Tools / Skills / sub-Agents / Memories,
 * renders the system prompt, inlines file URLs, and returns a stream-ready
 * config plus a `dispose` to release MCP clients.
 *
 * Caller passes the result to `streamText` and calls `dispose` on abort and
 * on `onFinish`. Persistence reads from `resolved`.
 *
 * The `queries` parameter defaults to the Drizzle adapter; tests pass an
 * in-memory implementation.
 */
export const prepareChatTurn = async (
  input: PrepareChatTurnInput,
  queries: ChatTurnQueries = drizzleChatTurnQueries,
): Promise<ChatTurn> => {
  const {
    orgId,
    workspaceId,
    user,
    request,
    messages,
    origin,
    frontendUrl,
    runMode = "interactive",
    onActivity,
  } = input;

  const workspace = await queries.getWorkspace(workspaceId);
  if (!workspace) {
    throw new NotFoundError(`Workspace '${workspaceId}' not found`);
  }

  const context = await resolveChatContext(
    queries,
    request,
    orgId,
    workspaceId,
  );
  const { provider, agent, resolvedModelId, resolvedMaxSteps } = context;

  const opened = openProvider(provider);
  const model = opened.languageModel(resolvedModelId);

  const [
    { tools, mcpClients },
    skills,
    { subAgents, subAgentTools, subAgentMcpClients },
    userContexts,
    memories,
    sandboxEnvKeys,
  ] = await Promise.all([
    loadTools(queries, agent, workspaceId, orgId, frontendUrl, user.id),
    loadSkills(queries, agent, orgId, workspaceId),
    loadSubAgents(queries, agent, orgId, workspaceId, frontendUrl, onActivity),
    queries.getUserContexts(user.id, workspaceId),
    queries.getRecentMemories(user.id, workspaceId),
    queries.getSandboxEnvKeys(workspaceId),
  ]);

  const allMcpClients = [...mcpClients, ...subAgentMcpClients];

  if (shouldInjectNativeSearch(request.search, provider)) {
    Object.assign(tools, opened.searchTools?.() ?? {});
  }

  Object.assign(tools, subAgentTools);

  const promptCtx: SystemPromptContext = {
    workspace: { id: workspaceId, context: workspace.context ?? undefined },
    agent: agent ?? null,
    user: {
      id: user.id,
      name: user.name,
      globalContext: userContexts.global,
      workspaceContext: userContexts.workspace,
    },
    memories,
    skills,
    subAgents,
    sandboxEnvKeys,
    fallbackSystemPrompt: request.systemPrompt,
    runMode,
  };

  const generation = resolveGenerationConfig(request, agent, promptCtx);

  if (skills.length > 0) {
    tools.loadSkill = createLoadSkillTool(orgId, workspaceId);
  }

  const heartbeat = onActivity ? createToolHeartbeat(onActivity) : null;

  const wrappedTools = heartbeat
    ? wrapToolsWithBump(
        tools,
        onActivity!,
        heartbeat.onToolStart,
        heartbeat.onToolEnd,
      )
    : tools;

  const inlinedMessages = origin
    ? await inlineFileUrls(messages, origin)
    : messages;

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    heartbeat?.stop();
    for (const client of allMcpClients) {
      try {
        await client.close();
      } catch (e) {
        logger.error({ error: e }, "Error closing MCP client");
      }
    }
  };

  const systemPrompt = generation.systemPrompt!;

  return {
    stream: {
      model,
      tools: wrappedTools,
      system: systemPrompt,
      messages: inlinedMessages,
      maxSteps: resolvedMaxSteps,
      temperature: generation.temperature,
      topP: generation.topP,
      topK: generation.topK,
      frequencyPenalty: generation.frequencyPenalty,
      presencePenalty: generation.presencePenalty,
      seed: request.seed,
    },
    resolved: {
      agentId: context.resolvedAgentId,
      providerId: context.resolvedProviderId,
      modelId: context.resolvedModelId,
      // Only Direct (no-Agent) turns persist generation params on the row;
      // Agent-driven turns read them back from the Agent record.
      systemPrompt: agent ? undefined : systemPrompt,
      temperature: agent ? undefined : generation.temperature,
      topP: agent ? undefined : generation.topP,
      topK: agent ? undefined : generation.topK,
      frequencyPenalty: agent ? undefined : generation.frequencyPenalty,
      presencePenalty: agent ? undefined : generation.presencePenalty,
      seed: agent ? undefined : request.seed,
    },
    dispose,
  };
};

// --- Private helpers ---

/**
 * Default cadence between heartbeat bumps while any tool is in flight. Must
 * be comfortably below the smallest configured per-step timeout (2 min for
 * chat by default) so a slow tool can't outlive the timer between heartbeats.
 */
export const DEFAULT_TOOL_HEARTBEAT_INTERVAL_MS = 30 * 1000;

/**
 * Tracks how many tool calls are currently executing and fires `bump()` at a
 * fixed cadence while that count is positive. Used by `prepareChatTurn` to
 * keep the run's per-step stall timer alive across a long tool call or a
 * sub-agent whose own tool calls yield no parts for an extended period.
 *
 * Exported for direct testing — production callers should always go through
 * `prepareChatTurn`.
 */
export const createToolHeartbeat = (
  bump: () => void,
  intervalMs: number = DEFAULT_TOOL_HEARTBEAT_INTERVAL_MS,
): {
  onToolStart: () => void;
  onToolEnd: () => void;
  stop: () => void;
  /** Visible for tests. Number of tool calls currently being tracked. */
  inflight: () => number;
} => {
  let inflight = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    onToolStart: () => {
      // Defensive: if a tool callback somehow fires after stop() (e.g. an
      // MCP transport that ignores AbortSignal), don't start a fresh timer
      // that nothing will clean up.
      if (stopped) return;
      inflight += 1;
      if (inflight === 1) {
        timer = setInterval(bump, intervalMs);
      }
    },
    onToolEnd: () => {
      inflight = Math.max(0, inflight - 1);
      if (inflight === 0 && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    stop: () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    inflight: () => inflight,
  };
};

/**
 * Wraps each tool's `execute` to:
 * 1. Emit `start` / `end` activity events for structured logging and the
 *    initial per-step timer bump (`runId`, `toolName`, `durationMs`).
 * 2. Call `onToolStart` / `onToolEnd` so the surrounding turn can maintain
 *    an inflight counter and run a heartbeat — the only thing that keeps
 *    the per-step timer alive across a tool call (or sub-agent) that takes
 *    longer than the stall threshold to settle.
 *
 * Sub-agent tools whose `execute` is an async generator are returned by
 * reference; the inflight bookkeeping still happens because they expose
 * an `execute` function and we wrap it the same way. Their inner part
 * yields continue to bump the timer via `onProgress` for visibility, but
 * correctness no longer depends on those yields being frequent enough.
 */
const wrapToolsWithBump = (
  tools: Record<string, Tool>,
  onActivity: (event?: ToolActivityEvent) => void,
  onToolStart: () => void,
  onToolEnd: () => void,
): Record<string, Tool> => {
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    const execute = (t as any).execute;
    if (typeof execute !== "function") {
      wrapped[name] = t;
      continue;
    }
    wrapped[name] = {
      ...t,
      execute: function (args: any, options: any) {
        const startedAt = Date.now();
        onToolStart();
        onActivity({ phase: "start", toolName: name });
        const finish = () => {
          onToolEnd();
          onActivity({
            phase: "end",
            toolName: name,
            durationMs: Date.now() - startedAt,
          });
        };
        let result: unknown;
        try {
          result = execute.call(t, args, options);
        } catch (err) {
          finish();
          throw err;
        }
        if (result && typeof (result as any).then === "function") {
          return (result as Promise<any>).finally(finish);
        }
        // Async iterable / generator path (sub-agent tools). Wrap it so the
        // counter decrements once the consumer drains the iterator.
        if (
          result &&
          typeof (result as any)[Symbol.asyncIterator] === "function"
        ) {
          const inner = result as AsyncIterable<unknown>;
          return (async function* () {
            try {
              for await (const part of inner) {
                yield part;
              }
            } finally {
              finish();
            }
          })();
        }
        finish();
        return result;
      },
    };
  }
  return wrapped;
};

const resolveChatContext = async (
  queries: ChatTurnQueries,
  data: ChatTurnRequest,
  orgId: string,
  workspaceId: string,
): Promise<ChatContext> => {
  const { agentId, providerId, modelId } = data;

  let resolvedProviderId: string;
  let resolvedModelId: string;
  let resolvedAgentId: string | undefined;
  let resolvedMaxSteps = 1;
  let agent: AgentRow | undefined;

  if (agentId) {
    resolvedAgentId = agentId;
    const found = await queries.getAgent(agentId, orgId, workspaceId);
    if (!found) throw new NotFoundError(`Agent '${agentId}' not found`);
    agent = found;
    resolvedProviderId = agent.providerId;
    resolvedModelId = agent.modelId;
    resolvedMaxSteps = agent.maxSteps ?? 1;
  } else if (providerId && modelId) {
    resolvedProviderId = providerId;
    resolvedModelId = modelId;
    resolvedAgentId = undefined;
  } else {
    throw new ValidationError(
      "Must provide either agentId or (providerId and modelId)",
    );
  }

  const provider = await queries.getProvider(
    resolvedProviderId,
    orgId,
    workspaceId,
  );
  if (!provider) {
    throw new NotFoundError(
      `Provider with id '${resolvedProviderId}' not found`,
    );
  }

  if (!provider.modelIds.includes(resolvedModelId)) {
    throw new ValidationError(
      `Model id '${resolvedModelId}' not enabled for provider '${resolvedProviderId}'`,
    );
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

const loadTools = async (
  queries: ChatTurnQueries,
  agent: AgentRow | undefined,
  workspaceId: string,
  orgId: string,
  frontendUrl: string | undefined,
  userId?: string,
): Promise<{ tools: Record<string, Tool>; mcpClients: any[] }> => {
  const tools: Record<string, Tool> = {};
  const mcpClients: any[] = [];

  if (!agent || !agent.toolSetIds || agent.toolSetIds.length === 0) {
    return { tools, mcpClients };
  }

  for (const toolSetId of agent.toolSetIds) {
    try {
      const toolSet = getToolSet(toolSetId);
      const resolvedTools =
        typeof toolSet.tools === "function"
          ? await toolSet.tools({
              workspaceId,
              agentId: agent.id,
              orgId,
              frontendUrl,
              userId: userId || "",
            })
          : toolSet.tools;
      Object.assign(tools, resolvedTools);
    } catch {
      // Static tool set not found — fall back to MCP lookup.
      const mcp = await queries.getMcp(toolSetId, orgId, workspaceId);
      if (mcp && mcp.url) {
        // An unreachable MCP must fail soft: log a warning and contribute no
        // tools, rather than throwing and killing the whole Chat turn. A Shared
        // (org-scoped) MCP has org-wide blast radius, so a single down server
        // must not break every attached Workspace's chats at once (ADR-0007).
        try {
          const mcpClient = await createMCPClient({
            transport: buildMcpTransportConfig(mcp),
          });
          const mcpTools = await mcpClient.tools();
          Object.assign(tools, mcpTools);
          mcpClients.push(mcpClient);
        } catch (error) {
          logger.warn(
            { error, mcpId: mcp.id, scope: mcp.organizationId ? "org" : "ws" },
            `MCP '${toolSetId}' is unreachable; skipping its tools`,
          );
        }
      } else if (mcp) {
        logger.warn(`MCP '${toolSetId}' has no URL configured`);
      } else {
        logger.warn(
          `Tool set with id '${toolSetId}' not found as static tool set or MCP`,
        );
      }
    }
  }

  return { tools, mcpClients };
};

const resolveGenerationConfig = (
  data: ChatTurnRequest,
  agent: AgentRow | undefined,
  promptCtx: SystemPromptContext,
): GenerationConfig => {
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

  config.systemPrompt = renderSystemPrompt(promptCtx);
  return config;
};

const loadSkills = async (
  queries: ChatTurnQueries,
  agent: AgentRow | undefined,
  orgId: string,
  workspaceId: string,
): Promise<Array<Pick<Skill, "name" | "description">>> => {
  if (!agent?.skillIds || agent.skillIds.length === 0) return [];
  return queries.getSkillsByIds(agent.skillIds, orgId, workspaceId);
};

const loadSubAgents = async (
  queries: ChatTurnQueries,
  agent: AgentRow | undefined,
  orgId: string,
  workspaceId: string,
  frontendUrl: string | undefined,
  onProgress?: () => void,
): Promise<{
  subAgents: Array<{ id: string; name: string; description?: string | null }>;
  subAgentTools: Record<string, Tool>;
  subAgentMcpClients: any[];
}> => {
  if (!agent?.subAgentIds || agent.subAgentIds.length === 0) {
    return { subAgents: [], subAgentTools: {}, subAgentMcpClients: [] };
  }

  const subAgentRecords = await queries.getSubAgentsByIds(agent.subAgentIds);

  const subAgents = subAgentRecords.map((sa) => ({
    id: sa.id,
    name: sa.name,
    description: sa.description,
  }));

  const subAgentMcpClients: any[] = [];

  const subAgentTools = await createSubAgentTools(
    subAgentRecords,
    async (providerId: string, modelId: string) => {
      const subProvider = await queries.getProvider(
        providerId,
        orgId,
        workspaceId,
      );
      if (!subProvider) {
        throw new Error(`Provider '${providerId}' not found for sub-agent`);
      }
      return openProvider(subProvider).languageModel(modelId);
    },
    async (subAgentId: string, toolSetIds: string[]) => {
      const subAgentRecord = subAgentRecords.find((sa) => sa.id === subAgentId);
      const { tools: subTools, mcpClients } = await loadTools(
        queries,
        subAgentRecord ?? ({ id: subAgentId, toolSetIds } as any),
        workspaceId,
        orgId,
        frontendUrl,
      );
      subAgentMcpClients.push(...mcpClients);
      return subTools;
    },
    onProgress,
  );

  return { subAgents, subAgentTools, subAgentMcpClients };
};
