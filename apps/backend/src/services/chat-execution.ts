import {
  experimental_createMCPClient as createMCPClient,
  type MCPClient,
} from "@ai-sdk/mcp";
import { openProvider } from "./provider.ts";
import { and, eq, or, inArray, sql } from "drizzle-orm";
import { db } from "../index.ts";
import {
  agent as agentTable,
  context as contextTable,
  mcp as mcpTable,
  organization as organizationTable,
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
import {
  createIdGenerator,
  generateText,
  type LanguageModel,
  type Tool,
} from "ai";
import { logger } from "../logger.ts";
import { buildMcpTransportConfig } from "./mcp-oauth-provider.ts";
import { inlineFileUrls } from "../storage/utils.ts";
import type { PlatypusUIMessage } from "../types.ts";
import { chat as chatTable } from "../db/schema.ts";
import {
  contextWindowResolver,
  DEFAULT_CONTEXT_WINDOW,
} from "../runs/context-window.ts";
import {
  estimateTokens,
  estimateOverheadTokens,
  imageProviderFor,
  uiMessagesToCountUnits,
  type ImageProvider,
} from "../runs/token-estimate.ts";
import {
  applyTier1Compaction,
  affectedBelowWatermark,
  buildCompactionTraceMessage,
  buildTier2PrepareStep,
  computeBudget,
  drizzleCompactionStore,
  invalidateCompaction,
  DEFAULT_COMPACTION_CONFIG,
  setCompactionDirty,
  type Budget,
  type CompactionConfig,
  type CompactionState,
  type CompactionTrace,
  type Summarize,
  type Tier2Context,
} from "../runs/compaction.ts";
import type { RecoveryContext } from "../runs/recovery.ts";

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
  /**
   * Chat id. Present for interactive chat turns (the chatSubmit payload);
   * absent for headless callers (triggers, sub-agents) whose `request` carries
   * no chat. Tier 1 compaction keys on it — see the skip guard in
   * `prepareChatTurn` (ADR-0012 §Sub-agents: headless runs are Tier 2 only).
   */
  id?: string;
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
  /**
   * Set when Tier 1 compaction fired this turn (ADR-0012 §Compaction trace in the timeline). agent-runner emits
   * a synthetic compact_context tool-call + tool-result pair into the stream so
   * the compaction is visible in the chat timeline.
   */
  compactionTrace?: CompactionTrace;
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
    /** Resolved context window for the main model (ADR-0012 §Context-usage ring, ADR-0012 §Per-message stats). */
    contextWindow: number;
    /** True when contextWindow fell to the conservative default (ADR-0012 §Context-usage ring: ring → neutral). */
    contextWindowIsDefault: boolean;
  };
  /**
   * Context-overflow recovery wiring (ADR-0012 §Recovery, ADR-0012 §Recovery is the net). Always present — recovery is
   * the safety net and stays on even when proactive compaction is disabled.
   * agent-runner wraps the model with the recovery middleware using this.
   */
  recovery: RecoveryContext;
  /**
   * Tier 2 in-turn compaction config (ADR-0012 §Tier 2). Null when proactive compaction is
   * disabled (ADR-0012 §Config & kill switch or agent override). agent-runner builds the
   * prepareStep callback from this and wires it into streamText/generateText.
   */
  tier2: Tier2Context | null;
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
  /**
   * Messages as they were in the DB BEFORE this submission's `ChatSink.onStart`
   * overwrote them — the ADR-0012 §Summary invalidation baseline for detecting edits below the watermark
   * (ADR-0012 §Summary invalidation). Loaded by agent-runner before calling onStart. When absent the ADR-0012 §Summary invalidation
   * check falls back to a DB read that now returns the post-overwrite state.
   */
  priorMessages?: PlatypusUIMessage[];
  /**
   * Run abort signal from the run registry. Threaded into the compaction
   * summarizer so a cancelled or timed-out run aborts the in-flight
   * `generateText` (review Fix B). Optional: callers without a registry-backed
   * run (tests, ad-hoc) omit it and the summarize call simply runs uncancelled.
   */
  signal?: AbortSignal;
  /**
   * Fires once, the instant a Tier 1 model summary begins, carrying the
   * before-stats (ADR-0012 §Compaction trace in the timeline live In-Progress).
   * agent-runner uses it to write the in-progress `compact_context` chunk into
   * the live stream before the model response. Not fired on prune-only/no-op
   * turns (no trace) or headless runs (no chat id).
   */
  onCompactionSummarizeStart?: (before: {
    tokensBefore: number;
    messagesBefore: number;
  }) => void;
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

  async getOrganization(id) {
    const rows = await db
      .select()
      .from(organizationTable)
      .where(eq(organizationTable.id, id))
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

// --- Tier 1 context compaction (ADR-0012) ---

const EMPTY_COMPACTION_STATE: CompactionState = {
  version: 0,
  summaryWatermark: null,
  contextSummary: null,
  compactionDirty: false,
};

/**
 * Resolves the effective global compaction config from DEFAULT_COMPACTION_CONFIG
 * + env overrides (ADR-0012 §Config & kill switch). Extracted so both
 * buildCompactionRuntime and the context-window endpoint (which surfaces
 * keepRecentMessages to the force-compact confirm gate) share one source of
 * truth. Pure — depends only on process.env.
 */
export function resolveCompactionConfig(): CompactionConfig {
  const config = { ...DEFAULT_COMPACTION_CONFIG };
  // Global kill switch (ADR-0012 §Config & kill switch) gates proactive compaction; recovery is unaffected.
  if (process.env.COMPACTION_ENABLED === "false") {
    config.compactionEnabled = false;
  }
  // Optional env overrides for the global ceiling (ADR-0012 §Config & kill switch). Unset/blank/invalid →
  // the DEFAULT_COMPACTION_CONFIG value stands, so production behavior is
  // unchanged. Intended for tuning the trigger on test deployments without a
  // code change. Keep targetRatio < triggerRatio or compaction re-fires every
  // turn (the thrash trap).
  // Reads + RANGE-VALIDATES a numeric env override (ADR-0012 §Config & kill switch). An out-of-range or
  // non-finite value is rejected (warn + fall back to the default) rather than
  // silently applied: the old `Number.isFinite`-only check let `0` and negatives
  // through, so `COMPACTION_KEEP_RECENT=0` summarized the current message away
  // and `COMPACTION_TRIGGER_RATIO=0` fired on empty chats.
  const numEnv = (
    name: string,
    raw: string | undefined,
    opts: { min?: number; max?: number; integer?: boolean } = {},
  ): number | undefined => {
    if (raw == null || raw === "") return undefined;
    let n = Number(raw);
    let invalid = !Number.isFinite(n);
    if (!invalid && opts.integer) n = Math.floor(n);
    if (!invalid && opts.min !== undefined && n < opts.min) invalid = true;
    if (!invalid && opts.max !== undefined && n > opts.max) invalid = true;
    if (invalid) {
      logger.warn(
        { env: name, raw, ...opts },
        "ignoring out-of-range compaction env override; using default",
      );
      return undefined;
    }
    return n;
  };
  const RATIO = { min: 0.01, max: 1 };
  config.triggerRatio =
    numEnv(
      "COMPACTION_TRIGGER_RATIO",
      process.env.COMPACTION_TRIGGER_RATIO,
      RATIO,
    ) ?? config.triggerRatio;
  config.targetRatio =
    numEnv(
      "COMPACTION_TARGET_RATIO",
      process.env.COMPACTION_TARGET_RATIO,
      RATIO,
    ) ?? config.targetRatio;
  config.reserveRatio =
    numEnv("COMPACTION_RESERVE_RATIO", process.env.COMPACTION_RESERVE_RATIO, {
      min: 0,
      max: 0.9,
    }) ?? config.reserveRatio;
  config.keepRecentMessages =
    numEnv("COMPACTION_KEEP_RECENT", process.env.COMPACTION_KEEP_RECENT, {
      min: 1,
      integer: true,
    }) ?? config.keepRecentMessages;
  config.minPrunableChars =
    numEnv(
      "COMPACTION_MIN_PRUNABLE_CHARS",
      process.env.COMPACTION_MIN_PRUNABLE_CHARS,
      {
        min: 1,
        integer: true,
      },
    ) ?? config.minPrunableChars;
  config.minRecentPrunableChars =
    numEnv(
      "COMPACTION_MIN_RECENT_PRUNABLE_CHARS",
      process.env.COMPACTION_MIN_RECENT_PRUNABLE_CHARS,
      { min: 1, integer: true },
    ) ?? config.minRecentPrunableChars;
  // ADR-0012 §Stage 0 — context editing. Disabled via
  // COMPACTION_CONTEXT_EDITING_ENABLED=false; recency/size gates tunable.
  if (process.env.COMPACTION_CONTEXT_EDITING_ENABLED === "false") {
    config.contextEditingEnabled = false;
  }
  config.keepRecentToolResults =
    numEnv(
      "COMPACTION_KEEP_RECENT_TOOL_RESULTS",
      process.env.COMPACTION_KEEP_RECENT_TOOL_RESULTS,
      { min: 0, integer: true },
    ) ?? config.keepRecentToolResults;
  config.minEditableToolChars =
    numEnv(
      "COMPACTION_MIN_EDITABLE_TOOL_CHARS",
      process.env.COMPACTION_MIN_EDITABLE_TOOL_CHARS,
      { min: 1, integer: true },
    ) ?? config.minEditableToolChars;

  // Hysteresis backstop (ADR-0012 §Tier 1 (hysteresis)): target must stay below trigger or
  // compaction re-fires every turn (ADR-0012 §Tier 1 hysteresis). The earlier runtime clamp was
  // dropped when per-agent config was removed (ADR-0012 §Config & kill switch); restore it here so an operator who
  // sets COMPACTION_TARGET_RATIO >= COMPACTION_TRIGGER_RATIO still runs safely.
  if (config.targetRatio >= config.triggerRatio) {
    const clamped = config.triggerRatio * 0.9;
    logger.warn(
      {
        targetRatio: config.targetRatio,
        triggerRatio: config.triggerRatio,
        clamped,
      },
      "COMPACTION_TARGET_RATIO >= COMPACTION_TRIGGER_RATIO; clamping target to triggerRatio*0.9 (hysteresis)",
    );
    config.targetRatio = clamped;
  }
  return config;
}

/**
 * Loads the canonical (raw) persisted history for a chat. Exported so
 * agent-runner can snapshot it BEFORE `ChatSink.onStart` overwrites the row —
 * that snapshot is the ADR-0012 §Summary invalidation baseline (ADR-0012 §Summary invalidation: onStart runs before prepareChatTurn,
 * so a read inside applyTier1IfNeeded would see the just-submitted messages).
 */
export async function loadChatMessages(
  chatId: string,
): Promise<PlatypusUIMessage[]> {
  const rows = await db
    .select({ messages: chatTable.messages })
    .from(chatTable)
    .where(eq(chatTable.id, chatId))
    .limit(1);
  return (rows[0]?.messages as PlatypusUIMessage[] | null) ?? [];
}

/**
 * Newest-first scan for the last assistant message carrying a POSITIVE
 * provider-reported `contextTokens` (the ADR-0012 §Context-usage ring stat). Skips two messages that would
 * otherwise shadow the real baseline:
 *  - the ADR-0012 §Force-compact on demand standalone trace message (assistant role, no `metadata.stats`) — ADR-0012 §Tier 1 (hysteresis);
 *  - a turn from a usage-less provider stamped `contextTokens = 0` — ADR-0012 §Tier 1 (trigger projection).
 * Either would make the Tier 1 projection drop the corrective baseline (and, for
 * the 0 case, the cold-start margin too).
 */
function findLastInputTokens(
  messages: PlatypusUIMessage[],
): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    const ct = (
      messages[i].metadata as { stats?: { contextTokens?: number } } | undefined
    )?.stats?.contextTokens;
    if (typeof ct === "number" && ct > 0) return ct;
  }
  return undefined;
}

/**
 * Everything the compaction machinery needs that is resolved once per turn:
 * the budget (from the resolved context window), the effective config, the
 * summarizer, and the summarizer's own window (ADR-0012 §Tier 1 (summarizer model & map-reduce)). Shared by Tier 1
 * and the recovery middleware (ADR-0012 §Recovery) so the two never disagree.
 */
type CompactionRuntime = {
  budget: Budget;
  config: CompactionConfig;
  imageProvider: ImageProvider;
  summarize: Summarize;
  summarizerWindow?: number;
  /** Resolved context window for the main model (ADR-0012 §Context-usage ring). */
  contextWindow: number;
  /** True when the window fell to the conservative default (ADR-0012 §Context-usage ring: ring → neutral). */
  contextWindowIsDefault: boolean;
};

/**
 * Builds the per-turn compaction runtime. Never throws: a failed window
 * resolution falls back to the conservative default so recovery (ADR-0012 §Recovery is the net) always
 * has a working configuration.
 */
/** Safety ceiling on summarizer output (ADR-0012 §Summarizer hardening). Prevents a runaway
 * model from producing a summary longer than its input. The system prompt
 * hard-limits to 1500 tokens; this 4000 backstop catches models that ignore
 * the instruction (e.g. qwen36 on large tool-heavy inputs). */
const SUMMARIZE_MAX_OUTPUT_TOKENS = 4000;

/** Heartbeat interval while the summarizer runs (ADR-0012 §Summarizer hardening). Resets the
 * per-step stall watchdog so a slow summarize call is not misidentified as a
 * frozen run and killed before it returns. */
const SUMMARIZE_HEARTBEAT_INTERVAL_MS = 10_000;

export async function buildCompactionRuntime(args: {
  chatId?: string;
  provider: Provider;
  resolvedModelId: string;
  opened: ReturnType<typeof openProvider>;
  /** When present, called every ~10 s during `summarize` to keep the per-step
   *  stall watchdog alive (ADR-0012 §Summarizer hardening). */
  onActivity?: () => void;
  /** Run abort signal, threaded into the summarizer `generateText` so a
   *  cancelled / per-run-timed-out run aborts the call instead of leaking it
   *  past the heartbeat-suppressed per-step watchdog (review Fix B). */
  signal?: AbortSignal;
}): Promise<CompactionRuntime> {
  const { chatId, provider, resolvedModelId, opened, onActivity, signal } =
    args;

  const config = resolveCompactionConfig();

  // ADR-0012 §Window resolution: resolve both windows concurrently (they are independent).
  const taskModelId = provider.taskModelId || resolvedModelId;
  const [mainWindow, summarizerWindowResult] = await Promise.all([
    contextWindowResolver.resolve(provider, resolvedModelId).catch((error) => {
      logger.error(
        { error, chatId, resolvedModelId },
        "context window resolution failed; using conservative default",
      );
      return null;
    }),
    contextWindowResolver.resolve(provider, taskModelId).catch(() => null),
  ]);

  const contextWindow = mainWindow?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxOutputTokens = mainWindow?.maxOutputTokens;
  const budget = computeBudget(contextWindow, maxOutputTokens, config);

  const summarizerWindow = summarizerWindowResult
    ? computeBudget(
        summarizerWindowResult.contextWindow,
        summarizerWindowResult.maxOutputTokens,
        config,
      ).inputBudget
    : undefined;

  // Summarizer uses the provider's task model, falling back to the main model
  // when unset (ADR-0012 §Tier 1 (summarizer model)). generateText is one-shot, no tools.
  const summarize = async (text: string): Promise<string> => {
    const startedAt = Date.now();
    // ADR-0012 §Summarizer hardening: keep the per-step stall watchdog alive while the
    // summarizer runs. Tier-1 compaction is legitimate long work, not a stall;
    // without this ping the 120 s watchdog fires and kills the run.
    const heartbeat = onActivity
      ? setInterval(onActivity, SUMMARIZE_HEARTBEAT_INTERVAL_MS)
      : null;
    try {
      const result = await generateText({
        model: opened.languageModel(taskModelId),
        // ADR-0012 §Summarizer hardening: structured handoff prompt — sections reduce loss
        // across repeated re-compactions (Codex CLI pattern); explicit concise
        // instruction + "aim under ~1500 tokens" pairs with the output ceiling.
        // Sections are ordered most-critical-first: if the output is truncated
        // at the ceiling (finishReason === "length"), the tail that drops is
        // the least resume-critical (file/tool detail), not intent or next step.
        system: `You are performing a context checkpoint compaction. Another instance of this assistant will resume using ONLY your summary plus the most recent messages — earlier history will be gone. Write a dense markdown handoff under these headings, in this order (omit one only if truly empty). Front-load the most important facts within each section — if you run long, later detail may be cut:

- **Intent & open requests** — what the user wants, the latest explicit request, pending tasks.
- **Current state & next step** — where things stand and the immediate next action.
- **Decisions & facts** — conclusions, confirmed values/IDs/paths, constraints and user preferences (preserve any security-relevant instruction verbatim).
- **Files & tools touched** — what was read/changed and why.

If a prior summary appears in the history, integrate it — don't drop facts it captured. Be concise: hard limit 1500 tokens maximum. Output only the summary.`,
        prompt: text,
        // ADR-0012 §Summarizer hardening: hard ceiling prevents a runaway model from
        // producing a summary longer than its input. Prompt hard-limits to
        // 1500 tokens; 4000 backstop catches models that ignore the instruction.
        maxOutputTokens: SUMMARIZE_MAX_OUTPUT_TOKENS,
        // Fix B (review): thread the run's abort signal so a cancelled or
        // per-run-timed-out run actually aborts this call. The heartbeat above
        // keeps the per-step watchdog from firing, so without this a hung
        // summarize would otherwise run until the 10 min per-run timeout.
        abortSignal: signal,
      });
      const { text: summary, usage, finishReason } = result;
      logger.info(
        {
          metric: "summarize.latency_ms",
          latencyMs: Date.now() - startedAt,
          chatId,
          taskModelId,
          usage,
          finishReason,
          hitOutputCeiling: finishReason === "length",
        },
        "context compaction summarize",
      );
      if (finishReason === "length") {
        logger.warn(
          { chatId, taskModelId, maxTokens: SUMMARIZE_MAX_OUTPUT_TOKENS },
          "summarize hit maxOutputTokens ceiling — summary may be truncated",
        );
      }
      return summary;
    } finally {
      if (heartbeat !== null) clearInterval(heartbeat);
    }
  };

  return {
    budget,
    config,
    imageProvider: imageProviderFor(provider.providerType),
    summarize,
    summarizerWindow,
    contextWindow,
    contextWindowIsDefault: !mainWindow || mainWindow.source === "default",
  };
}

type ApplyTier1Args = {
  chatId: string;
  runtime: CompactionRuntime;
  /** Post-inlineFileUrls messages — used for the compaction itself (ADR-0012 §Token estimation). */
  messages: PlatypusUIMessage[];
  /**
   * Pre-inlineFileUrls messages from this submission — used as the incoming
   * side of the ADR-0012 §Summary invalidation divergence check (ADR-0012 §Summary invalidation). Must NOT be inlined: the persisted
   * side also uses storage:// / http:// URLs, so both sides are comparable.
   */
  rawMessages: PlatypusUIMessage[];
  /**
   * Messages as they were in the DB BEFORE this submission's onStart overwrote
   * them (ADR-0012 §Summary invalidation). When absent, the ADR-0012 §Summary invalidation check falls back to a fresh DB read, which
   * returns the post-overwrite state and therefore never detects edits.
   */
  priorMessages?: PlatypusUIMessage[];
  /** Estimated system-prompt + tool-schema payload for this turn (ADR-0012 §Tier 1 (trigger projection)). */
  overheadTokens: number;
  /** Provider-reported `usage.inputTokens` from the prior turn (ADR-0012 §Tier 1 (trigger projection), ADR-0012 §Context-usage ring). */
  lastInputTokens?: number;
  /** Fires once when a model summary begins, carrying before-stats (ADR-0012 §Compaction trace in the timeline live In-Progress). */
  onSummarizeStart?: (before: {
    tokensBefore: number;
    messagesBefore: number;
  }) => void;
};

type Tier1IfNeededResult = {
  messages: PlatypusUIMessage[];
  compactionTrace?: CompactionTrace;
};

/**
 * Reconstructs/advances the compacted view and persists any new summary — all
 * best-effort. Any throw degrades to the uncompacted messages (recovery ADR-0012 §Recovery
 * remains the safety net). Returns the messages to send to the model plus an
 * optional compactionTrace for the stream trace (ADR-0012 §Compaction trace in the timeline).
 */
async function applyTier1IfNeeded(
  args: ApplyTier1Args,
): Promise<Tier1IfNeededResult> {
  const { chatId, runtime, messages, rawMessages } = args;
  try {
    const store = drizzleCompactionStore;
    let state = (await store.readState(chatId)) ?? EMPTY_COMPACTION_STATE;

    // ADR-0012 §Summary invalidation: if the submitted history changed at/below the watermark
    // (edit/delete/regenerate), reset the stale summary before compacting. The
    // single submit endpoint is the only "edit handler" in this architecture.
    //
    // ADR-0012 §Summary invalidation fix: the baseline must be the DB state BEFORE this submission's
    // onStart overwrote the row. agent-runner reads it before calling onStart
    // and threads it here as `priorMessages`. We also compare the pre-inline
    // (`rawMessages`) side so file-URL inlining doesn't trigger false positives.
    if (state.summaryWatermark || state.contextSummary) {
      const persisted = args.priorMessages ?? (await loadChatMessages(chatId));
      const affected = affectedBelowWatermark(
        persisted,
        rawMessages,
        state.summaryWatermark,
      );
      if (affected.length > 0) {
        const orderedIds = rawMessages
          .map((m) => m.id)
          .filter((id): id is string => Boolean(id));
        await invalidateCompaction(store, chatId, affected, orderedIds);
        state = (await store.readState(chatId)) ?? state;
      }
    }

    const result = await applyTier1Compaction({
      chatId,
      messages,
      state,
      budget: runtime.budget,
      config: runtime.config,
      imageProvider: runtime.imageProvider,
      summarize: runtime.summarize,
      summarizerWindow: runtime.summarizerWindow,
      overheadTokens: args.overheadTokens,
      lastInputTokens: args.lastInputTokens,
      store,
      onEvent: (event) =>
        logger.info({ chatId, ...event }, "context-compacted"),
      onSummarizeStart: args.onSummarizeStart,
    });

    return {
      messages: result.messages,
      compactionTrace: result.compactionTrace,
    };
  } catch (error) {
    logger.error(
      { error, chatId },
      "Tier 1 compaction failed; sending uncompacted history",
    );
    return { messages };
  }
}

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
    signal,
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
    { subAgents, subAgentTools, subAgentMcpClients },
    userContexts,
    memories,
    sandboxEnvKeys,
  ] = await Promise.all([
    loadTools(queries, agent, workspaceId, orgId, frontendUrl, user.id),
    loadSkills(queries, agent, orgId, workspaceId),
    loadSubAgents(
      queries,
      agent,
      orgId,
      workspaceId,
      frontendUrl,
      onActivity,
      signal,
    ),
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

  // --- Context compaction & recovery (ADR-0012) ---
  // The runtime (window budget, config, summarizer) is resolved once and shared
  // by Tier 1 and the recovery middleware so they never disagree. Never throws.
  const compactionRuntime = await buildCompactionRuntime({
    chatId: request.id,
    provider,
    resolvedModelId,
    opened,
    // Thread the activity callback so the summarizer heartbeat can bump the
    // per-step stall watchdog (ADR-0012 §Summarizer hardening). `onActivity` accepts an
    // optional event, so it satisfies the `() => void` heartbeat signature
    // directly — the interval invokes it with no event (timer-only bump).
    onActivity,
    // Thread the abort signal so a cancelled/timed-out run aborts summarize
    // instead of leaking past the heartbeat-suppressed watchdog (review Fix B).
    signal,
  });

  // Per-turn overhead: system prompt + tool schemas, sent on every turn but
  // invisible to a message-only estimate (ADR-0012 §Tier 1 (trigger projection)).
  const overheadTokens = estimateOverheadTokens(systemPrompt, wrappedTools);

  // Tier 1 is best-effort: a failure here must never break the turn — recovery
  // (ADR-0012 §Recovery) is the net. Runs AFTER inlineFileUrls so the estimate sees the real
  // payload (ADR-0012 §Token estimation). Cross-turn durable compaction is keyed by chat id; headless
  // runs (triggers, sub-agents) carry no chat id and have no durable history to
  // compact (ADR-0012 §Sub-agents — they are Tier 2 only), so send messages uncompacted.
  const chatId = request.id;
  const tier1Result = chatId
    ? await applyTier1IfNeeded({
        chatId,
        runtime: compactionRuntime,
        messages: inlinedMessages,
        // Pre-inline messages for ADR-0012 §Summary invalidation comparison (ADR-0012 §Summary invalidation): both sides must use the
        // same URL format (storage:// / http://) to avoid false positives.
        rawMessages: messages,
        // Pre-overwrite baseline threaded from agent-runner (ADR-0012 §Summary invalidation).
        priorMessages: input.priorMessages,
        overheadTokens,
        // Prior turn's provider-reported input token count (ADR-0012 §Tier 1 (trigger projection) / ADR-0012 §Context-usage ring): the
        // corrective baseline for the Tier 1 trigger projection on turns ≥ 2.
        // Absent on turn 1 → cold-start margin applies.
        lastInputTokens: findLastInputTokens(messages),
        // Live In-Progress trace (ADR-0012 §Compaction trace in the timeline):
        // fires the instant a model summary starts so agent-runner can write
        // the in-progress chunk before the model response streams.
        onSummarizeStart: input.onCompactionSummarizeStart,
      })
    : { messages: inlinedMessages };
  const compactedMessages = tier1Result.messages;

  // Recovery (ADR-0012 §Recovery, ADR-0012 §Recovery is the net): always wired, even when proactive compaction is off.
  // Headless runs get trim+retry but no dirty flag (no durable chat row).
  const recovery: RecoveryContext = {
    chatId,
    imageProvider: compactionRuntime.imageProvider,
    // ADR-0012 §Tier 1 (budget math): subtract the per-turn overhead so recovery uses the same effective
    // target as Tier 1. Without this, a large overhead (e.g. 65%+ of the window)
    // means the recovery retry still overflows even after trimming.
    targetTokens: Math.max(
      0,
      compactionRuntime.budget.targetTokens - overheadTokens,
    ),
    keepRecentMessages: compactionRuntime.config.keepRecentMessages,
    minPrunableChars: compactionRuntime.config.minPrunableChars,
    summarize: compactionRuntime.summarize,
    summarizerWindow: compactionRuntime.summarizerWindow,
    markDirty: chatId
      ? () => setCompactionDirty(drizzleCompactionStore, chatId)
      : undefined,
  };

  return {
    stream: {
      model,
      tools: wrappedTools,
      system: systemPrompt,
      messages: compactedMessages,
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
      contextWindow: compactionRuntime.contextWindow,
      contextWindowIsDefault: compactionRuntime.contextWindowIsDefault,
    },
    compactionTrace: tier1Result.compactionTrace,
    recovery,
    tier2: compactionRuntime.config.compactionEnabled
      ? {
          // ADR-0012 §Tier 1 (budget math) (Tier 2): the prepareStep estimate counts ModelMessages only —
          // system prompt + tool schemas go as separate streamText params and
          // are invisible to it, yet they consume the same window. Subtract the
          // per-turn overhead so the trigger/target reflect the real wire
          // payload (mirrors the Tier 1 and recovery targets above). Without
          // this, a large overhead lets the payload blow past the budget before
          // Tier 2 ever fires — exactly the tool-heavy case it exists for.
          triggerTokens: Math.max(
            0,
            compactionRuntime.budget.triggerTokens - overheadTokens,
          ),
          targetTokens: Math.max(
            0,
            compactionRuntime.budget.targetTokens - overheadTokens,
          ),
          keepRecentMessages: compactionRuntime.config.keepRecentMessages,
          minPrunableChars: compactionRuntime.config.minPrunableChars,
          imageProvider: compactionRuntime.imageProvider,
          summarize: compactionRuntime.summarize,
          summarizerWindow: compactionRuntime.summarizerWindow,
        }
      : null,
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
          return (result as Promise<unknown>).finally(finish);
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
    resolvedMaxSteps = agent.maxSteps ?? DEFAULT_AGENT_MAX_STEPS;
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
  signal?: AbortSignal,
): Promise<{
  subAgents: Array<{ id: string; name: string; description?: string | null }>;
  subAgentTools: Record<string, Tool>;
  subAgentMcpClients: MCPClient[];
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

  // Provider lookups are memoized so the Tier 2 loop below and the
  // createModelFn callback don't each re-fetch + re-open the same provider
  // (F1): one getProvider + openProvider per distinct providerId per turn.
  const providerCache = new Map<
    string,
    { provider: Provider; opened: ReturnType<typeof openProvider> } | null
  >();
  const resolveSubProvider = async (providerId: string) => {
    if (!providerCache.has(providerId)) {
      const p = await queries.getProvider(providerId, orgId, workspaceId);
      providerCache.set(
        providerId,
        p ? { provider: p, opened: openProvider(p) } : null,
      );
    }
    return providerCache.get(providerId) ?? null;
  };

  // Tier 2 only for sub-agents (ADR-0012 §Sub-agents: no durable history for Tier 1).
  // Resolve per-sub-agent compaction runtime so each sub-agent's tool loop
  // gets a prepareStep calibrated to its own model's context window.
  const subAgentPrepareSteps = new Map<
    string,
    import("ai").PrepareStepFunction
  >();
  // Per-sub-agent overflow recovery (ADR-0012 §Sub-agents). Built ALWAYS — recovery (ADR-0012 §Recovery is the net) is
  // the net even when the ADR-0012 §Config & kill switch disables proactive compaction, exactly
  // as on the main path. Tier 2 (below) is the only part gated by the switch.
  const subAgentRecoveries = new Map<string, RecoveryContext>();
  await Promise.all(
    subAgentRecords.map(async (sa) => {
      try {
        const resolved = await resolveSubProvider(sa.providerId);
        if (!resolved) return;
        const runtime = await buildCompactionRuntime({
          // Sub-agents have no chat row; tag logs with the sub-agent id (F3).
          chatId: sa.id,
          provider: resolved.provider,
          resolvedModelId: sa.modelId,
          opened: resolved.opened,
          // Thread heartbeat + abort so a sub-agent summarizer isn't killed by
          // the stall watchdog and aborts on run cancel/timeout (m3).
          onActivity: onProgress,
          signal,
        });
        // ADR-0012 §Tier 1 (budget math): subtract the sub-agent's per-turn
        // overhead so its recovery/Tier 2 targets match the main path. The
        // sub-agent's tool schemas resolve lazily at invocation and aren't
        // available here, so the system prompt — the dominant, predictable
        // component — is the floor; under-counting overhead only trims slightly
        // less aggressively, and recovery's force-halving still backstops it.
        const subOverheadTokens = estimateOverheadTokens(
          sa.systemPrompt ?? undefined,
          undefined,
        );
        // Recovery net first (not gated by compactionEnabled). No markDirty —
        // sub-agents have no durable chat row to flag.
        subAgentRecoveries.set(sa.id, {
          chatId: sa.id,
          imageProvider: runtime.imageProvider,
          targetTokens: Math.max(
            0,
            runtime.budget.targetTokens - subOverheadTokens,
          ),
          keepRecentMessages: runtime.config.keepRecentMessages,
          minPrunableChars: runtime.config.minPrunableChars,
          summarize: runtime.summarize,
          summarizerWindow: runtime.summarizerWindow,
        });
        if (!runtime.config.compactionEnabled) return;
        const tier2: Tier2Context = {
          triggerTokens: Math.max(
            0,
            runtime.budget.triggerTokens - subOverheadTokens,
          ),
          targetTokens: Math.max(
            0,
            runtime.budget.targetTokens - subOverheadTokens,
          ),
          keepRecentMessages: runtime.config.keepRecentMessages,
          minPrunableChars: runtime.config.minPrunableChars,
          imageProvider: runtime.imageProvider,
          summarize: runtime.summarize,
          summarizerWindow: runtime.summarizerWindow,
        };
        subAgentPrepareSteps.set(sa.id, buildTier2PrepareStep(tier2));
      } catch (error) {
        logger.warn(
          { error, subAgentId: sa.id },
          "Failed to build Tier 2 for sub-agent; skipping",
        );
      }
    }),
  );

  const subAgentMcpClients: MCPClient[] = [];

  const subAgentTools = await createSubAgentTools(
    subAgentRecords,
    async (providerId: string, modelId: string) => {
      const resolved = await resolveSubProvider(providerId);
      if (!resolved) {
        throw new Error(`Provider '${providerId}' not found for sub-agent`);
      }
      // Each sub-agent gets its OWN resolved provider's security text appended
      // to its instructions (not the parent's, not the org identity) — the one
      // path sub-agents have to the guardrails, since they never call
      // renderSystemPrompt.
      return {
        model: resolved.opened.languageModel(modelId),
        securityGuardrails: resolved.provider.securityGuardrails ?? null,
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
    (id) => subAgentPrepareSteps.get(id),
    (id) => subAgentRecoveries.get(id),
  );

  return { subAgents, subAgentTools, subAgentMcpClients };
};

// --- Force-compact endpoint (ADR-0012 §Force-compact on demand) ---

/**
 * Runs Tier 1 compaction unconditionally for a chat (ADR-0012 §Force-compact on demand: clickable ring).
 * Forces the compaction regardless of the token threshold by injecting
 * compactionDirty=true so the ADR-0012 §Recovery force path bypasses the estimate gate.
 * Called from `POST /chats/:id/compact`; the route guards against concurrent
 * runs before calling here.
 */
export async function forceCompactChat(
  chatId: string,
  workspaceId: string,
  orgId: string,
  /** Request abort signal — threaded into the summarizer so a client disconnect
   *  or hung summarize aborts the call instead of leaking and hanging the route
   *  (m3). */
  signal?: AbortSignal,
): Promise<{
  estimatedTokens: number;
  /** Message-only estimate of the history BEFORE compaction (same basis as estimatedTokens). */
  tokensBefore: number;
  /** Number of prefix messages folded into the summary this run (0 if no summary). */
  messagesDropped: number;
  /** The config keep-recent count — the client compares messagesDropped against it. */
  keepRecentMessages: number;
  contextWindow: number;
  contextWindowIsDefault: boolean;
  /** ADR-0012 §Compaction trace in the timeline — the persisted synthetic trace message, when a summary was produced. */
  traceMessage?: PlatypusUIMessage;
}> {
  // Load the chat record (workspace-scoped).
  const chatRows = await db
    .select({
      agentId: chatTable.agentId,
      providerId: chatTable.providerId,
      modelId: chatTable.modelId,
    })
    .from(chatTable)
    .where(
      and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
    )
    .limit(1);
  if (chatRows.length === 0) throw new NotFoundError("Chat not found");
  const chatRow = chatRows[0];

  // Resolve provider + model via the shared query layer (respects org-scoped
  // Shared resources and the ADR-0007 attachment gate).
  let provider: Provider;
  let resolvedModelId: string;

  if (chatRow.agentId) {
    const agentRow = await drizzleChatTurnQueries.getAgent(
      chatRow.agentId,
      orgId,
      workspaceId,
    );
    if (!agentRow) throw new NotFoundError("Agent not found");
    resolvedModelId = agentRow.modelId;
    const providerRow = await drizzleChatTurnQueries.getProvider(
      agentRow.providerId,
      orgId,
      workspaceId,
    );
    if (!providerRow) throw new NotFoundError("Provider not found");
    provider = providerRow;
  } else if (chatRow.providerId && chatRow.modelId) {
    const providerRow = await drizzleChatTurnQueries.getProvider(
      chatRow.providerId,
      orgId,
      workspaceId,
    );
    if (!providerRow) throw new NotFoundError("Provider not found");
    provider = providerRow;
    resolvedModelId = chatRow.modelId;
  } else {
    throw new ValidationError("Chat has no provider/model configured");
  }

  const opened = openProvider(provider);
  const runtime = await buildCompactionRuntime({
    chatId,
    provider,
    resolvedModelId,
    opened,
    signal,
  });

  const messages = await loadChatMessages(chatId);
  const rawState =
    (await drizzleCompactionStore.readState(chatId)) ?? EMPTY_COMPACTION_STATE;

  // Force-trigger by marking dirty in the in-memory copy (ADR-0012 §Recovery: bypass the
  // estimate gate so the compaction actually shrinks the history).
  const forcedState: CompactionState = { ...rawState, compactionDirty: true };

  const result = await applyTier1Compaction({
    chatId,
    messages,
    state: forcedState,
    budget: runtime.budget,
    config: runtime.config,
    imageProvider: runtime.imageProvider,
    summarize: runtime.summarize,
    store: drizzleCompactionStore,
    summarizerWindow: runtime.summarizerWindow,
  });

  // Message-only estimate (no per-turn system/tool overhead): the ring uses it
  // as a transient post-compact value that the next response's provider count
  // supersedes. It therefore reads slightly low vs the live ring numerator
  // (which includes overhead) — acceptable for an immediate visual refresh.
  const estimatedTokens = estimateTokens(
    uiMessagesToCountUnits(result.messages, runtime.imageProvider),
  );
  // Pre-compaction estimate (same basis) so the client can decide whether the
  // drop is significant enough to confirm — ADR-0012 §Force-compact on demand.
  const tokensBefore = estimateTokens(
    uiMessagesToCountUnits(messages, runtime.imageProvider),
  );

  // ADR-0012 §Compaction trace in the timeline: a forced compaction has no live stream to inject the trace into, so
  // persist it as a standalone synthetic assistant message. Appended after the
  // last real message — above the watermark (which already advanced inside
  // applyTier1Compaction), so it is never itself summarized. The strip filter
  // keeps it out of the model payload on subsequent turns. Only written when a
  // model summary was actually produced (result.compactionTrace is undefined
  // otherwise — see Tier1Output).
  let traceMessage: PlatypusUIMessage | undefined;
  if (result.compactionTrace) {
    traceMessage = buildCompactionTraceMessage(
      result.compactionTrace,
      createIdGenerator({ prefix: "msg", size: 16 })(),
    );
    // Atomic jsonb append: concatenate at the DB rather than overwrite
    // the whole column from the in-memory `messages` snapshot loaded earlier.
    // The route guards with runRegistry.has(chatId), but a run that registers in
    // the has()→write window — or a second concurrent POST /compact — would
    // otherwise be clobbered by this stale array. `||` appends to whatever is
    // stored now, so no concurrently-written messages are lost.
    await db
      .update(chatTable)
      .set({
        messages: sql`coalesce(${chatTable.messages}, '[]'::jsonb) || ${JSON.stringify([traceMessage])}::jsonb`,
      })
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
      );
  }

  return {
    estimatedTokens,
    tokensBefore,
    messagesDropped: result.compactionTrace?.messagesDropped ?? 0,
    keepRecentMessages: runtime.config.keepRecentMessages,
    contextWindow: runtime.contextWindow,
    contextWindowIsDefault: runtime.contextWindowIsDefault,
    traceMessage,
  };
}
