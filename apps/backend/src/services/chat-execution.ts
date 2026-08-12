import {
  experimental_createMCPClient as createMCPClient,
  type MCPClient,
} from "@ai-sdk/mcp";
import { openProvider, type OpenedProvider } from "./provider.ts";
import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  agent as agentTable,
  context as contextTable,
  mcp as mcpTable,
  organization as organizationTable,
  sandbox as sandboxTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { getToolSet } from "../tools/index.ts";
import { createLoadSkillTool } from "../tools/skill.ts";
import {
  createSubAgentTools,
  type SubAgentFailure,
} from "../tools/sub-agent.ts";
import { normalizeToolResult } from "./tool-result.ts";
import { resolveSamplingSettings } from "./sampling-settings.ts";
import {
  renderSystemPrompt,
  type SystemPromptContext,
} from "../system-prompt.ts";
import {
  retrieveRecentSummaries,
  type MemorySummary,
} from "./memory-retrieval.ts";
import {
  aliasNameFromReference,
  providerHasNativeSearch,
} from "@platypus/schemas";
import type { ConcreteModelId, Provider, Skill } from "@platypus/schemas";
import {
  getWebBackend,
  type WebBackendContext,
} from "../web-backends/index.ts";
import type { LanguageModel, Tool } from "ai";
import { logger } from "../logger.ts";
import { buildMcpTransportConfig } from "./mcp-oauth-provider.ts";
import { inlineFileUrls } from "../storage/utils.ts";
import {
  maxExtractedTextCharsForModel,
  passthroughFileTypesForModel,
  resolveModelId,
} from "./model-capability.ts";
import {
  assertFilePartsSupported,
  messagesHaveFileParts,
  normalizeFileParts,
} from "./file-gate.ts";
import type { PlatypusUIMessage } from "../types.ts";
import { listScopedByIds, resolveScoped } from "./scoped-resource.ts";

/**
 * Default agentic step ceiling for an agent that has no explicit `maxSteps`.
 * Mirrors the new-agent create-form default. Keeps API-created agents sane
 * (a single step never lets a tool-calling agent finish its work) while
 * staying low enough to bound a model that fails to converge.
 */
export const DEFAULT_AGENT_MAX_STEPS = 15;

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
type OrganizationRow = typeof organizationTable.$inferSelect;
type McpRow = typeof mcpTable.$inferSelect;

type ChatContext = {
  provider: Provider;
  agent?: AgentRow;
  /**
   * What the Agent or request actually stores — a concrete id or `alias:<name>`.
   * Kept alongside the resolved id because it, not the resolution, is what gets
   * persisted back to `chat.modelId`: writing the resolved id would pin the Chat
   * to today's model and repointing the alias would never reach it (ADR-0017).
   */
  modelReference: string;
  resolvedModelId: ConcreteModelId;
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
  instructions?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
};

export type ChatTurn = {
  stream: {
    model: LanguageModel;
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
    instructions?: string;
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
  /**
   * The sub-Agents among `ids` that are visible in the invoking Workspace, in
   * the order they were assigned. Ids that do not resolve are simply absent —
   * the caller reports them as unavailable.
   */
  getSubAgentsByIds(
    ids: string[],
    orgId: string,
    workspaceId: string,
  ): Promise<AgentRow[]>;
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
 * Every resource a Chat turn resolves goes through the Scoped-resource read
 * module: Workspace-scoped rows, plus the Organization-scoped (Shared) rows
 * attached to the invoking Workspace (ADR-0007). Each lookup below used to carry
 * its own copy of that rule, and the copies drifted — the sub-Agent one had no
 * scope filter at all, and each treated "has an organizationId, has no
 * workspaceId" as the definition of Shared, which lets a row carrying both
 * columns resolve in a Workspace that neither owns nor attached it.
 */
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
    // A Shared Agent runs only in a Workspace it is attached to (ADR-0007); its
    // Sandbox/MCP tools still rebind to that invoking Workspace via loadTools.
    const found = await resolveScoped(db, "agent", id, {
      orgId,
      wsId: workspaceId,
    });
    return found?.row ?? null;
  },

  async getProvider(id, orgId, workspaceId) {
    const found = await resolveScoped(db, "provider", id, {
      orgId,
      wsId: workspaceId,
    });
    return (found?.row as Provider | undefined) ?? null;
  },

  async getSkillsByIds(ids, orgId, workspaceId) {
    const visible = await listScopedByIds(db, "skill", ids, {
      orgId,
      wsId: workspaceId,
    });

    // A workspace-scoped Skill wins a name collision with an attached org-scoped
    // one, matching loadSkill's workspace-first resolution — so the advertised
    // list and the tool agree on which body the model loads, with no duplicate
    // entry in the system prompt.
    const workspaceSkills = visible.filter((s) => s.scope === "workspace");
    const seen = new Set(workspaceSkills.map(({ row }) => row.name));
    return [
      ...workspaceSkills,
      ...visible.filter(
        (s) => s.scope === "organization" && !seen.has(s.row.name),
      ),
    ].map(({ row }) => ({ name: row.name, description: row.description }));
  },

  async getMcp(id, orgId, workspaceId) {
    const found = await resolveScoped(db, "mcp", id, {
      orgId,
      wsId: workspaceId,
    });
    return found?.row ?? null;
  },

  async getSubAgentsByIds(ids, orgId, workspaceId) {
    // A sub-Agent resolves at the parent's Workspace scope, or at Organization
    // scope where attached (ADR-0007) — the same rule `getAgent` applies, and the
    // same authority the save-time check uses. Looked up by id alone, an Agent
    // from another Workspace resolved here: its name and description reached this
    // prompt, and its Provider then failed to resolve.
    const visible = await listScopedByIds(db, "agent", ids, {
      orgId,
      wsId: workspaceId,
    });

    // Returned in assignment order so the prompt lists sub-agents the way the
    // Operator configured them, not in whichever order the scope queries ran.
    const byId = new Map(visible.map(({ row }) => [row.id, row]));
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is AgentRow => row !== undefined);
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
 * How this turn's web-search slot is filled: by a plugin Web-search backend, by
 * the provider's native tool, or not at all.
 *
 * Three-valued rather than a boolean because the decision and the *reason* for it
 * are one thing (ADR-0014's explicit-plugin-first resolution). A boolean gate plus
 * a re-derived branch at the injection site meant a reader had to prove that a
 * passing gate with no `webBackend` implied native capability; carrying the
 * backend id in the result removes that step and the unreachable branch with it.
 *
 * This is the single authority over the chat search toggle: it covers the
 * raw-model and agent paths alike, and ignores a stale client that still sends
 * `search: true` for a provider that cannot serve it (#167).
 *
 * Precedence, in order:
 * 1. the request did not opt in → `none`;
 * 2. the Operator switched search off on this provider → `none`
 *    (`nativeSearchEnabled` is undefined for legacy rows, treated as enabled);
 * 3. a Web-search backend is selected → `backend`, *ahead of* native search —
 *    explicit Operator selection beats implicit provider capability, and a
 *    native-first `??` would never reach the backend on exactly the providers
 *    this feature targets;
 * 4. the provider has a native tool → `native`;
 * 5. otherwise `none`.
 *
 * Step 4 adds backend-side capability gating that did not exist before: the gate
 * used to be the toggle alone, with the provider-capability check living only in
 * the frontend. It is the stale-client case ADR-0014 calls out, not a regression —
 * a client asking Bedrock for search got an empty tool set anyway.
 *
 * `nativeSearchEnabled: false` wins over a configured `webBackend` (step 2 before
 * step 3): the switch currently means "no search on this provider at all". That
 * makes an Operator who disabled a *native* tool that never worked also silently
 * disable a plugin backend they later select — a field-naming problem PR3 carries
 * (see PLAN § PR3), not a resolution-order one.
 */
export type SearchResolution =
  { kind: "none" } | { kind: "native" } | { kind: "backend"; backend: string };

export const resolveSearchMode = (
  requestedSearch: boolean | undefined,
  provider: Pick<
    Provider,
    "providerType" | "apiMode" | "nativeSearchEnabled" | "webBackend"
  >,
): SearchResolution => {
  if (!requestedSearch) return { kind: "none" };
  if (provider.nativeSearchEnabled === false) return { kind: "none" };
  if (provider.webBackend) {
    return { kind: "backend", backend: provider.webBackend };
  }
  if (providerHasNativeSearch(provider)) return { kind: "native" };
  return { kind: "none" };
};

/**
 * Build the search tools this turn serves, per {@link resolveSearchMode}.
 *
 * Awaited alongside `loadTools` and the sub-agent load rather than after them: a
 * backend's `createExecutors` may open a network connection or warm a pool, and
 * its `timeoutMs` budget (30s by default, 120s ceiling) would otherwise land on
 * first-token latency *on top of* the other network waits instead of beside them.
 */
const resolveSearchTools = async (
  resolution: SearchResolution,
  opened: Pick<OpenedProvider, "searchTools">,
  provider: Pick<Provider, "id">,
  ctx: WebBackendContext,
): Promise<Record<string, Tool>> => {
  if (resolution.kind === "none") return {};
  if (resolution.kind === "native") return opened.searchTools?.() ?? {};

  const registration = getWebBackend(resolution.backend);
  if (!registration) {
    // The column holds free text and the plugin that contributed this id may
    // since have been removed from PLATYPUS_PLUGINS. Degrade to no search tools
    // rather than falling back to native, which would silently serve a different
    // search than the Operator selected.
    //
    // `providerId` is the actionable field: an org-scoped Shared Provider
    // (ADR-0007) is one row serving many Workspaces, so `workspaceId` alone names
    // a symptom while the fix is an edit to the Provider this warn cannot
    // otherwise identify.
    logger.warn(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        providerId: provider.id,
        webBackend: resolution.backend,
      },
      "provider.webBackend references an unregistered web backend; serving no search tools this turn",
    );
    return {};
  }
  return registration.buildTurnTools(ctx);
};

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

  // Org identity is framing, not a hard dependency — a missing org row must not
  // fail the turn, so this is a soft lookup rather than a NotFoundError.
  const organization = await queries.getOrganization(orgId);

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
    { subAgents, unavailableSubAgents, subAgentTools, subAgentMcpClients },
    userContexts,
    memories,
    sandboxEnvKeys,
    searchTools,
  ] = await Promise.all([
    loadTools(queries, agent, workspaceId, orgId, frontendUrl, user.id),
    loadSkills(queries, agent, orgId, workspaceId),
    loadSubAgents(queries, agent, orgId, workspaceId, frontendUrl, onActivity),
    queries.getUserContexts(user.id, workspaceId),
    queries.getRecentMemories(user.id, workspaceId),
    queries.getSandboxEnvKeys(workspaceId),
    resolveSearchTools(
      resolveSearchMode(request.search, provider),
      opened,
      provider,
      { orgId, workspaceId, userId: user.id },
    ),
  ]);

  const allMcpClients = [...mcpClients, ...subAgentMcpClients];

  // Assignment order is the precedence order, and it is deliberate: search lands
  // after `loadTools` so it wins over an agent/MCP tool that happens to share a
  // name (exactly as native search already did), and before `subAgentTools` so a
  // sub-agent's tools still win over search.
  Object.assign(tools, searchTools);
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
    unavailableSubAgents,
    sandboxEnvKeys,
    fallbackInstructions: request.instructions,
    runMode,
    securityGuardrails: provider.securityGuardrails,
    organizationIdentityContext: organization?.identityContext,
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

  // Inline file URLs to `data:` bytes when we have an origin, then ALWAYS
  // normalize (issues #328, #342): text-like files become annotated text,
  // PDF/DOCX are extracted to capped annotated text, native files pass through
  // untouched, and any part that couldn't be inlined — a storage miss, or a
  // headless turn with no origin — is announced as unavailable rather than
  // forwarded raw. Normalizing even without an origin keeps a stray file part on
  // a headless turn from hard-failing conversion. The pre-persist gate
  // (`validateTurnAttachments`) has already rejected files nothing can convert,
  // so the normalizer here never throws.
  const passthroughFileTypes = passthroughFileTypesForModel(
    provider,
    resolvedModelId,
  );
  const inlinedMessages = await normalizeFileParts(
    origin ? await inlineFileUrls(messages, origin) : messages,
    passthroughFileTypes,
    {
      maxExtractedTextChars: maxExtractedTextCharsForModel(
        provider,
        resolvedModelId,
      ),
    },
  );

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
      seed: generation.seed,
    },
    resolved: {
      agentId: context.resolvedAgentId,
      providerId: context.resolvedProviderId,
      // The reference, not the resolution — see `ChatContext.modelReference`.
      modelId: context.modelReference,
      // Only Direct (no-Agent) turns persist generation params on the row;
      // Agent-driven turns read them back from the Agent record.
      //
      // What is persisted here is the user's OWN instructions, never the
      // composed system prompt above: this column backs the editable
      // Instructions box in Chat settings, so writing the composite made the
      // workspace context, the user's identity, memories and the provider's
      // guardrails reappear as editable text — and compound on every turn
      // (issue #365). What the model receives is unaffected; `stream.system`
      // still carries the composite.
      instructions: agent ? undefined : request.instructions,
      temperature: agent ? undefined : generation.temperature,
      topP: agent ? undefined : generation.topP,
      topK: agent ? undefined : generation.topK,
      frequencyPenalty: agent ? undefined : generation.frequencyPenalty,
      presencePenalty: agent ? undefined : generation.presencePenalty,
      seed: agent ? undefined : generation.seed,
    },
    dispose,
  };
};

/**
 * Pre-persist file gate (issue #328). Resolves the target model's declared
 * `passthroughFileTypes` and rejects the turn — before anything is persisted —
 * if any attached file (fresh upload or history) is neither natively accepted,
 * text-like, nor a document extraction can convert to text (#342 — a freshly
 * uploaded document is extracted here to prove it, so a scanned PDF is refused
 * before it can enter history). Throws `FileValidationError`, which the chat
 * route maps to a 400 naming the offending file(s).
 *
 * A no-op when the turn carries no file parts (the common case, including all
 * headless runs), so it adds no lookups there. If model resolution itself fails
 * (unknown agent/provider/model), it silently returns and lets the normal
 * `prepareChatTurn` path surface that error unchanged — this gate only adds the
 * file-rejection behavior, it never preempts existing error handling.
 */
export const validateTurnAttachments = async (
  args: {
    request: ChatTurnRequest;
    messages: PlatypusUIMessage[];
    orgId: string;
    workspaceId: string;
  },
  queries: ChatTurnQueries = drizzleChatTurnQueries,
): Promise<void> => {
  if (!messagesHaveFileParts(args.messages)) return;

  let passthroughFileTypes: string[];
  try {
    const context = await resolveChatContext(
      queries,
      args.request,
      args.orgId,
      args.workspaceId,
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
/**
 * Re-exported so callers and tests that reach the normalizer through this
 * module keep working. It lives in `tool-result.ts` because the sub-agent tool
 * builder needs it too, and this module already imports that one.
 *
 * `wrapToolsWithBump` applies it at the promise-resolved and synchronous return
 * paths, covering every value-returning tool on the parent turn at once. The
 * async-iterable path (sub-agent delegate tools) is intentionally exempt — its
 * yields are streamed UI parts, not the result fed to the model.
 */
export { normalizeToolResult };

export const wrapToolsWithBump = (
  tools: Record<string, Tool>,
  onActivity: (event?: ToolActivityEvent) => void,
  onToolStart: () => void,
  onToolEnd: () => void,
): Record<string, Tool> => {
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    const execute = (t as { execute?: unknown }).execute;
    if (typeof execute !== "function") {
      wrapped[name] = t;
      continue;
    }
    const runExecute = execute as (args: unknown, options: unknown) => unknown;
    wrapped[name] = {
      ...t,
      execute: (args: unknown, options: unknown) => {
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
          result = runExecute.call(t, args, options);
        } catch (err) {
          finish();
          throw err;
        }
        if (
          result != null &&
          typeof (result as { then?: unknown }).then === "function"
        ) {
          return (result as Promise<unknown>)
            .then(normalizeToolResult)
            .finally(finish);
        }
        // Async iterable / generator path (sub-agent tools). Wrap it so the
        // counter decrements once the consumer drains the iterator.
        if (
          result != null &&
          typeof (result as Record<symbol, unknown>)[Symbol.asyncIterator] ===
            "function"
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
        // Normalize before finish() so the sync path mirrors the promise path:
        // a throw (e.g. a BigInt in the result) happens before the "end" event.
        const normalized = normalizeToolResult(result);
        finish();
        return normalized;
      },
    };
  }
  return wrapped;
};

/**
 * Why a model reference resolved to nothing, said in the caller's terms: a
 * dangling alias and a dangling concrete id are different mistakes to fix.
 */
const unresolvedModelMessage = (
  reference: string,
  providerId: string,
): string => {
  const aliasName = aliasNameFromReference(reference);
  return aliasName === null
    ? `Model id '${reference}' not enabled for provider '${providerId}'`
    : `Model alias '${aliasName}' is not defined on provider '${providerId}'`;
};

const resolveChatContext = async (
  queries: ChatTurnQueries,
  data: ChatTurnRequest,
  orgId: string,
  workspaceId: string,
): Promise<ChatContext> => {
  const { agentId, providerId, modelId } = data;

  let resolvedProviderId: string;
  // The reference AS STORED — a concrete id, or `alias:<name>` (ADR-0017).
  let modelReference: string;
  let resolvedAgentId: string | undefined;
  let resolvedMaxSteps = 1;
  let agent: AgentRow | undefined;

  if (agentId) {
    resolvedAgentId = agentId;
    const found = await queries.getAgent(agentId, orgId, workspaceId);
    if (!found) throw new NotFoundError(`Agent '${agentId}' not found`);
    agent = found;
    resolvedProviderId = agent.providerId;
    modelReference = agent.modelId;
    resolvedMaxSteps = agent.maxSteps ?? DEFAULT_AGENT_MAX_STEPS;
  } else if (providerId && modelId) {
    resolvedProviderId = providerId;
    modelReference = modelId;
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

  // Aliases re-resolve on EVERY turn — no pinning — so repointing an alias
  // moves every Agent and Chat using it on their next turn. A reference that
  // matches nothing is a hard error, never a fallback to some other model.
  const resolvedModelId = resolveModelId(provider, modelReference);
  if (!resolvedModelId) {
    throw new ValidationError(
      unresolvedModelMessage(modelReference, resolvedProviderId),
    );
  }

  return {
    provider,
    agent,
    modelReference,
    resolvedModelId,
    resolvedProviderId,
    resolvedAgentId,
    resolvedMaxSteps,
  };
};

const loadTools = async (
  queries: ChatTurnQueries,
  agent: Pick<AgentRow, "id" | "toolSetIds"> | undefined,
  workspaceId: string,
  orgId: string,
  frontendUrl: string | undefined,
  userId?: string,
): Promise<{ tools: Record<string, Tool>; mcpClients: MCPClient[] }> => {
  const tools: Record<string, Tool> = {};
  const mcpClients: MCPClient[] = [];

  if (!agent || !agent.toolSetIds || agent.toolSetIds.length === 0) {
    return { tools, mcpClients };
  }

  for (const toolSetId of agent.toolSetIds) {
    let toolSet: ReturnType<typeof getToolSet>;
    try {
      toolSet = getToolSet(toolSetId);
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
      continue;
    }

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
  }

  return { tools, mcpClients };
};

const resolveGenerationConfig = (
  data: ChatTurnRequest,
  agent: AgentRow | undefined,
  promptCtx: SystemPromptContext,
): GenerationConfig => {
  // `seed` is resolved from the same source as the other five. It used to be
  // read straight off the request instead, so an Agent's stored Seed was
  // silently ignored on every Agent-driven turn.
  const config: GenerationConfig = resolveSamplingSettings(agent || data);

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

/**
 * Reason reported for an assigned sub-agent id that does not resolve in the
 * invoking Workspace — deleted, or a Shared Agent detached from (or never
 * attached to) this Workspace. Deliberately says nothing about the row itself.
 */
const UNRESOLVED_SUB_AGENT_REASON =
  "not available in this workspace — it may have been deleted, or it is a shared agent that is not attached here";

const loadSubAgents = async (
  queries: ChatTurnQueries,
  agent: AgentRow | undefined,
  orgId: string,
  workspaceId: string,
  frontendUrl: string | undefined,
  onProgress?: () => void,
): Promise<{
  subAgents: Array<{ id: string; name: string; description?: string | null }>;
  unavailableSubAgents: SubAgentFailure[];
  subAgentTools: Record<string, Tool>;
  subAgentMcpClients: MCPClient[];
}> => {
  if (!agent?.subAgentIds || agent.subAgentIds.length === 0) {
    return {
      subAgents: [],
      unavailableSubAgents: [],
      subAgentTools: {},
      subAgentMcpClients: [],
    };
  }

  const assignedIds = [...new Set(agent.subAgentIds)];
  const subAgentRecords = await queries.getSubAgentsByIds(
    assignedIds,
    orgId,
    workspaceId,
  );

  // An assigned id that does not resolve in this Workspace is reported by id
  // alone: it is either gone, or a Shared Agent that is not attached here, and
  // reading a name off the row is exactly the boundary crossing being avoided.
  const resolvedIds = new Set(subAgentRecords.map((sa) => sa.id));
  const unresolved: SubAgentFailure[] = assignedIds
    .filter((id) => !resolvedIds.has(id))
    .map((id) => ({ id, reason: UNRESOLVED_SUB_AGENT_REASON }));

  const subAgentMcpClients: MCPClient[] = [];

  const { tools: subAgentTools, failures } = await createSubAgentTools(
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
      // A sub-Agent is an Agent row, so its `modelId` may hold an alias
      // reference and needs the same resolution the parent turn gets — this
      // path never goes through `resolveChatContext`.
      const subModelId = resolveModelId(subProvider, modelId);
      if (!subModelId) {
        throw new Error(
          `${unresolvedModelMessage(modelId, providerId)} (sub-agent)`,
        );
      }
      // Each sub-agent gets its OWN resolved provider's security text appended
      // to its instructions (not the parent's, not the org identity) — the one
      // path sub-agents have to the guardrails, since they never call
      // renderSystemPrompt.
      return {
        model: openProvider(subProvider).languageModel(subModelId),
        securityGuardrails: subProvider.securityGuardrails ?? null,
      };
    },
    async (subAgentId: string, toolSetIds: string[]) => {
      const subAgentRecord = subAgentRecords.find((sa) => sa.id === subAgentId);
      const { tools: subTools, mcpClients } = await loadTools(
        queries,
        subAgentRecord ?? { id: subAgentId, toolSetIds },
        workspaceId,
        orgId,
        frontendUrl,
      );
      subAgentMcpClients.push(...mcpClients);
      return subTools;
    },
    onProgress,
  );

  // The system prompt must describe only sub-agents that produced a callable
  // tool. Listing one that dropped out tells the model to call a tool that was
  // never registered, and the turn dies on AI_NoSuchToolError.
  const failedIds = new Set(failures.map((f) => f.id));
  const subAgents = subAgentRecords
    .filter((sa) => !failedIds.has(sa.id))
    .map((sa) => ({
      id: sa.id,
      name: sa.name,
      description: sa.description,
    }));

  return {
    subAgents,
    unavailableSubAgents: [...unresolved, ...failures],
    subAgentTools,
    subAgentMcpClients,
  };
};
