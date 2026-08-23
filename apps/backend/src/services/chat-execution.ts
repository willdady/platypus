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
import {
  deferCloserRegistrar,
  openToolSession,
  type ToolSession,
  type ToolSessionScope,
} from "../tools/tool-session.ts";
import { createLoadSkillTool } from "../tools/skill.ts";
import {
  createSubAgentTools,
  type SubAgentFailure,
} from "../tools/sub-agent.ts";
import { normalizeToolResult } from "./tool-result.ts";
import {
  renderSystemPrompt,
  type SystemPromptContext,
} from "../system-prompt.ts";
import {
  retrieveRecentSummaries,
  type MemorySummary,
} from "./memory-retrieval.ts";
import {
  nextTurnOccupancy,
  providerHasNativeSearch,
  SEARCH_SOURCE_NATIVE,
  SEARCH_SOURCE_NONE,
} from "@platypus/schemas";
import type { ConcreteModelId, Provider, Skill } from "@platypus/schemas";
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
import {
  wrapToolsWithActivity,
  type ToolActivityEvent,
} from "./tool-activity.ts";
import type {
  ParentRunContext,
  ChatTurnRequest,
  ResolvedGeneration,
} from "../runs/types.ts";
import {
  resolveGenerationPlan,
  type GenerationSource,
} from "../runs/agent-plan.ts";
import type { RunPlan } from "../runs/run-plan.ts";
import { NotFoundError, ValidationError } from "../errors.ts";

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
  /**
   * Everything `resolveGenerationPlan` decided this turn generates under —
   * model, step ceiling, output ceiling, sampling — assembled once so a Chat
   * turn and a delegated sub-Agent can never resolve it differently (issues
   * #417, #456, #459).
   */
  plan: Omit<RunPlan, "system" | "tools">;
  /** The resolved Provider's free-text security directives, or null. */
  guardrails: string | null;
};

/**
 * The slim request shape `prepareChatTurn` actually consumes: agent/provider
 * selection plus generation overrides. Re-exported so this module's existing
 * callers keep resolving it from here. Lives in `runs/types.ts` — not here —
 * so `runs/` never imports a type from `services/` (see `RunInput`, which
 * also carries this shape).
 */
export type { ChatTurnRequest };

export type ChatTurn = {
  stream: RunPlan & { messages: PlatypusUIMessage[] };
  resolved: ResolvedGeneration;
  /**
   * Search was requested and resolution served no search tools, so the turn
   * runs without it — an **Unavailable capability** (`CONTEXT.md`), issue #522.
   *
   * A sibling of `stream` and not a field on `resolved`, which describes the
   * turn's plan and is mirrored into run records: this is an outcome of
   * building that plan, not part of it.
   *
   * The runner forwards it to the drive, which stamps it onto the streamed
   * message's metadata for the Chat to render. The model is never told.
   */
  searchUnavailable?: boolean;
  dispose: () => Promise<void>;
};

/**
 * The Context occupancy a new Chat turn starts at, before its own first step
 * has reported any usage (ADR-0018 Notes, issue #524).
 *
 * Read from the last assistant message that carries a `contextOccupancy`
 * reading — mirroring the context-meter derivation in `chat.tsx` — and summed
 * by the shared `nextTurnOccupancy`, which both sides call so the meter and
 * this gate cannot read the same turn differently. `null` (an erased,
 * mid-turn-stale reading) counts as unknown, same as absent.
 *
 * Undefined for a Chat's first turn, and for a delegated Sub-Agent or headless
 * Trigger run, which never pass a prior Chat's messages here at all — Tool-result
 * clearing simply does not engage on their first model call.
 */
const initialOccupancyFrom = (
  messages: PlatypusUIMessage[],
): number | undefined => {
  const lastReading = messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.metadata?.contextOccupancy)
    .filter((reading) => reading !== undefined)
    .at(-1);
  return nextTurnOccupancy(lastReading);
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
   * Called when a tool call begins and again when it settles. The run
   * lifecycle logs both and holds its per-step stall timer down in between, so
   * a long tool call (MCP web search, a delegated sub-agent run) is never read
   * as a stalled step.
   */
  onActivity?: (event: ToolActivityEvent) => void;
  /**
   * The run this turn belongs to. Sub-agent delegate tools built here register
   * their own runs as children of it, so a delegated run is cancellable and
   * subject to the same timeouts in its own right. Absent for callers that
   * prepare a turn outside the run lifecycle (tests, the pre-persist file gate).
   */
  run?: ParentRunContext;
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
      workspaceId,
    });
    return found?.row ?? null;
  },

  async getProvider(id, orgId, workspaceId) {
    const found = await resolveScoped(db, "provider", id, {
      orgId,
      workspaceId,
    });
    return (found?.row as Provider | undefined) ?? null;
  },

  async getSkillsByIds(ids, orgId, workspaceId) {
    const visible = await listScopedByIds(db, "skill", ids, {
      orgId,
      workspaceId,
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
      workspaceId,
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
      workspaceId,
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
 * passing gate with no backend selected implied native capability; carrying the
 * backend id in the result removes that step and the unreachable branch with it.
 *
 * This is the single authority over the chat search toggle: it covers the
 * raw-model and agent paths alike, and ignores a stale client that still sends
 * `search: true` for a provider that cannot serve it (#167).
 *
 * Precedence, in order:
 * 1. the request did not opt in → `none`;
 * 2. `provider.searchSource` is `"none"` (or a legacy row with no value at
 *    all) → `none`;
 * 3. `provider.searchSource` names a Web-search backend → `backend`, *ahead
 *    of* native search — explicit Operator selection beats implicit provider
 *    capability, and a native-first `??` would never reach the backend on
 *    exactly the providers this feature targets;
 * 4. `provider.searchSource` is `"native"` and the provider has a native tool
 *    → `native`;
 * 5. otherwise `none` — covers `"native"` on a provider with no native tool
 *    (a stale value, e.g. a Bedrock row backfilled from the pre-collapse
 *    columns) so a stored value that can no longer resolve degrades exactly
 *    like an unregistered backend id does, rather than being trusted blind.
 *
 * Step 4's capability check is backend-side gating that did not exist before
 * ADR-0014: the gate used to be the toggle alone, with the provider-capability
 * check living only in the frontend. It is the stale-client case the ADR calls
 * out, not a regression — a client asking Bedrock for search got an empty tool
 * set anyway.
 *
 * `searchSource` collapses what used to be two fields fighting over one slot
 * (`nativeSearchEnabled` + `webBackend`, ADR-0014): a switch that gated
 * *both* paths under a name that only mentioned one, and a select that
 * fought it for the same decision. One field, one precedence list, no
 * unreachable branch.
 */
export type SearchResolution =
  { kind: "none" } | { kind: "native" } | { kind: "backend"; backend: string };

export const resolveSearchMode = (
  requestedSearch: boolean | undefined,
  provider: Pick<Provider, "providerType" | "apiMode" | "searchSource">,
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
  ctx: WithCoreRegistrar<WebBackendContext>,
): Promise<Record<string, Tool>> => {
  // Core's own context for the seam: `providerId` is the actionable field on
  // every warn below, and a backend never sees it — `composeWebBackend` strips
  // it before the plugin-facing `createExecutors` call.
  const turnCtx = { ...ctx, providerId: provider.id };

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
        searchSource: resolution.backend,
      },
      "provider.searchSource references an unregistered web backend; serving no search tools this turn",
    );
    return {};
  }
  return registration.buildTurnTools(turnCtx);
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
    run,
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
  const { provider, agent, resolvedModelId } = context;

  // Opened again here (resolveGenerationPlan already opened it once, to build
  // `context.plan.model`) only for its native search tools — a concern the
  // generation plan itself has no reason to know about.
  const opened = openProvider(provider);

  // Where this turn runs, shared by the Agent and every delegate it may reach.
  const scope: ToolSessionScope = {
    orgId,
    workspaceId,
    userId: user.id,
    frontendUrl,
  };
  // Started before the `Promise.all` rather than inside it because the delegates
  // built alongside it nest their own sessions into this one — they take the
  // promise, not the session, and await it only if they are ever invoked.
  const sessionPromise = openToolSession(scope, agent, queries);
  // The search path is awaited *beside* the session below, not after it, so it
  // cannot be handed the session itself — it gets a registrar that defers onto
  // the promise. See `deferCloserRegistrar`.
  const registerCloser = deferCloserRegistrar(sessionPromise);

  // Hoisted out of the `Promise.all` argument list so the resolution and the
  // tools it produced are both in scope below — the pair is what says whether
  // search was promised and not delivered. Pure and synchronous, so nothing
  // about the awaited work moves.
  const searchResolution = resolveSearchMode(request.search, provider);

  const [
    session,
    skills,
    { subAgents, unavailableSubAgents, subAgentTools },
    userContexts,
    memories,
    sandboxEnvKeys,
    searchTools,
  ] = await Promise.all([
    sessionPromise,
    loadSkills(queries, agent, orgId, workspaceId),
    loadSubAgents(queries, agent, scope, sessionPromise, run),
    queries.getUserContexts(user.id, workspaceId),
    queries.getRecentMemories(user.id, workspaceId),
    queries.getSandboxEnvKeys(workspaceId),
    resolveSearchTools(searchResolution, opened, provider, {
      orgId,
      workspaceId,
      userId: user.id,
      registerCloser,
    }),
  ]);

  // Search was asked for, resolution had somewhere to send it, and nothing came
  // back (issue #522). Outcome-based rather than a branch per cause, so an
  // unregistered backend, a factory that threw or timed out and a missing
  // `web_search` executor are all one condition — as is whatever cause is added
  // next. An empty native tool set would land here too, though nothing can
  // produce one today. The three server-side warns still name the specific
  // fault for the Operator; this is what the person reading the reply is told.
  const searchUnavailable =
    searchResolution.kind !== "none" && Object.keys(searchTools).length === 0;

  // Assignment order is the precedence order, and it is deliberate: search lands
  // after the session's tools so it wins over an agent/MCP tool that happens to
  // share a name (exactly as native search already did), and before
  // `subAgentTools` so a sub-agent's tools still win over search.
  const tools: Record<string, Tool> = { ...session.tools };
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
    securityGuardrails: context.guardrails,
    organizationIdentityContext: organization?.identityContext,
  };

  const systemPrompt = renderSystemPrompt(promptCtx);

  if (skills.length > 0) {
    tools.loadSkill = createLoadSkillTool(orgId, workspaceId);
  }

  // Activity events only. Result normalization (#321) is no longer bolted on
  // here: it happens for every tool the Tool session loads, whether or not this
  // turn is being observed. The tools core adds itself above — search, the
  // sub-agent delegates, `loadSkill` — return core-owned JSON shapes.
  const wrappedTools = onActivity
    ? wrapToolsWithActivity(tools, onActivity)
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

  // Read from the INCOMING history, before this turn appends anything — Tool-
  // result clearing's only reading for the first model call of the turn
  // (ADR-0018 Notes, issue #524). Left off entirely rather than sent as
  // `undefined` when there is no prior reading, matching every other optional
  // field on this plan.
  const initialOccupancy = initialOccupancyFrom(messages);

  return {
    stream: {
      ...context.plan,
      tools: wrappedTools,
      system: systemPrompt,
      messages: inlinedMessages,
      ...(initialOccupancy !== undefined ? { initialOccupancy } : {}),
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
      temperature: agent ? undefined : context.plan.temperature,
      topP: agent ? undefined : context.plan.topP,
      topK: agent ? undefined : context.plan.topK,
      frequencyPenalty: agent ? undefined : context.plan.frequencyPenalty,
      presencePenalty: agent ? undefined : context.plan.presencePenalty,
      seed: agent ? undefined : context.plan.seed,
    },
    searchUnavailable,
    // The session closes what it opened, delegates' nested sessions included —
    // the caller no longer reconciles two lists of clients to get there.
    dispose: session.dispose,
  };
};

/**
 * Pre-persist file gate (issue #328). Resolves the target model's declared
 * `passthroughFileTypes` and rejects the turn — before anything is persisted —
 * if any attached file (fresh upload or history) is neither natively accepted,
 * text-like, nor a document extraction can convert to text (#342 — a freshly
 * uploaded document is extracted here to prove it, so a scanned PDF is refused
 * before it can enter history). Throws `FileValidationError`, which the
 * central `onError` (ADR-0010) maps to a 400 naming the offending file(s).
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
 * Re-exported so callers and tests that reach these through this module keep
 * working. They live in their own modules because the sub-agent tool builder
 * needs them too, and this module imports that one.
 */
export { normalizeToolResult };
export { wrapToolsWithActivity, type ToolActivityEvent };

/**
 * Resolves the Agent-or-direct selection down to a `GenerationSource`
 * (`resolveGenerationPlan`'s input), fetching the Agent row when `agentId` is
 * given. The one place that decides whether THIS turn's fields — not an
 * Agent's — feed the plan; the plan resolution itself is shared with every
 * sub-Agent delegation (`loadSubAgents` below).
 */
const resolveChatContext = async (
  queries: ChatTurnQueries,
  data: ChatTurnRequest,
  orgId: string,
  workspaceId: string,
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
    };
  } else {
    throw new ValidationError(
      "Must provide either agentId or (providerId and modelId)",
    );
  }

  const { plan, provider, resolvedModelId, modelReference, guardrails } =
    await resolveGenerationPlan(source, { orgId, workspaceId }, queries);

  return {
    provider,
    agent,
    modelReference,
    resolvedModelId,
    // The Provider `resolveGenerationPlan` resolved IS the one named by the
    // Agent or the direct selection above — its own id is simplest to read.
    resolvedProviderId: provider.id,
    resolvedAgentId,
    plan,
    guardrails,
  };
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
  scope: ToolSessionScope,
  session: Promise<ToolSession>,
  run: ParentRunContext | undefined,
): Promise<{
  subAgents: Array<{ id: string; name: string; description?: string | null }>;
  unavailableSubAgents: SubAgentFailure[];
  subAgentTools: Record<string, Tool>;
}> => {
  if (!agent?.subAgentIds || agent.subAgentIds.length === 0) {
    return {
      subAgents: [],
      unavailableSubAgents: [],
      subAgentTools: {},
    };
  }

  const { orgId, workspaceId } = scope;
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

  const { tools: subAgentTools, failures } = await createSubAgentTools(
    subAgentRecords,
    // A sub-Agent's plan is resolved the same way the parent turn's is —
    // through `resolveGenerationPlan`, not a second copy of model/ceiling/
    // sampling resolution (this path used to say, in so many words, that it
    // never went through `resolveChatContext`).
    (subAgent) =>
      resolveGenerationPlan(
        { agent: subAgent },
        { orgId, workspaceId },
        queries,
      ),
    // Called on a delegate's FIRST invocation, not now: a parent with three
    // MCP-backed delegates used to open — and warn about — every one of their
    // servers on every Chat turn, whether or not it delegated. The nested
    // session closes with the parent's, so a delegate never hands its
    // connections back to be remembered.
    //
    // The delegate runs under its parent's Workspace and user (its scope is
    // chained from theirs, and `actorUserId` walks back up to the same human), so
    // its Tool sets resolve against the same identity. They used to be handed an
    // empty `userId`, which silently blanked the user a delegate's tools ran as.
    async (subAgentId: string, toolSetIds: string[]) => {
      const parent = await session;
      const nested = await parent.nest({ id: subAgentId, toolSetIds });
      return nested.tools;
    },
    run,
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
  };
};
