import {
  pgTable,
  index,
  unique,
  uniqueIndex,
  customType,
  foreignKey,
  primaryKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Import and re-export auth schema
export * from "./auth-schema.ts";
import { user } from "./auth-schema.ts";
import type { KanbanCardHistoryChange } from "@platypus/schemas";
import type { ListToolsResult } from "@ai-sdk/mcp";

// Custom vector type without fixed dimensions — allows variable-dimension vectors per workspace
const unboundVector = customType<{
  data: number[];
  driverParam: string;
}>({
  dataType() {
    return "vector";
  },
  toDriver(value: number[]): string {
    return JSON.stringify(value);
  },
  fromDriver(value: unknown): number[] {
    if (typeof value === "string") {
      return JSON.parse(value) as number[];
    }
    return value as number[];
  },
});

export const organization = pgTable("organization", (t) => ({
  id: t.text("id").primaryKey(),
  name: t.text("name").notNull(),
  // Free-text org identity / context, rendered early in the system prompt as
  // framing (not a security control). Nullable — existing orgs are unchanged.
  identityContext: t.text("identity_context"),
  // Which Workspaces may take Inbound Trigger calls (ADR-0030): "off" |
  // "all" | "selected". Checked on every call, so changing it takes effect
  // on the next one. Settable only by an Org Admin.
  inboundTriggerGate: t.text("inbound_trigger_gate").notNull().default("off"),
  // Which Workspaces may have A2A endpoints (ADR-0032), in the same shape as
  // the Inbound Trigger gate and separate from it. Checked on every call.
  a2aGate: t.text("a2a_gate").notNull().default("off"),
  createdAt: t.timestamp("created_at").notNull().defaultNow(),
  updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
}));

// Provider defined before workspace to avoid circular reference with task_model_provider_id.
// workspaceId intentionally carries no FK to `workspace`: a cascade FK would
// race `agent.providerId`'s `restrict` constraint (Postgres checks RESTRICT
// immediately, not deferred to end of statement), so the Workspace delete
// route deletes Workspace-scoped Providers explicitly instead (issue #661).
export const provider = pgTable(
  "provider",
  (t) => ({
    id: t.text("id").primaryKey(),
    organizationId: t
      .text("organization_id")
      .references(() => organization.id, {
        onDelete: "cascade",
      }),
    workspaceId: t.text("workspace_id"),
    name: t.text("name").notNull(),
    providerType: t.text("provider_type").notNull(),
    apiKey: t.text("api_key").notNull(),
    region: t.text("region"),
    baseUrl: t.text("base_url"),
    headers: t.jsonb().$type<Record<string, string>>(),
    extraBody: t.jsonb().$type<Record<string, unknown>>(),
    organization: t.text("organization"),
    project: t.text("project"),
    apiMode: t.text("api_mode").notNull().default("responses"),
    // Which of "no search" / this provider's own tool / a plugin Web-search
    // backend serves the chat search toggle (ADR-0014). Free text, not an
    // enum or FK, for the same reason `webBackend` was: the valid backend-id
    // set is whichever plugins the deployment loaded, which the database
    // cannot know. A value whose plugin is later removed degrades to no
    // search tools plus a warn-log, so no backfill or constraint is needed
    // for that case.
    searchSource: t.text("search_source").notNull().default("native"),
    // Free-text security directives appended last in the system prompt for
    // every run on this provider (and sub-agent runs resolved to it). Nullable
    // — existing providers are unchanged.
    securityGuardrails: t.text("security_guardrails"),
    // Per-model config (see `modelConfigSchema` in @platypus/schemas). Legacy
    // rows may still hold a bare `string[]`; the backend normalizes both shapes
    // via `resolveProviderModels`, and migration 0047 backfills stored rows.
    modelIds: t
      .jsonb()
      .$type<Array<{ id: string; passthroughFileTypes: string[] }> | string[]>()
      .notNull(),
    taskModelId: t.text("task_model_id").notNull(),
    memoryExtractionModelId: t.text("memory_extraction_model_id").notNull(),
    embeddingModelId: t.text("embedding_model_id"),
    embeddingDimensions: t.integer("embedding_dimensions"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_provider_workspace_id").on(t.workspaceId),
    index("idx_provider_organization_id").on(t.organizationId),
    unique("unique_provider_name_org").on(t.organizationId, t.name),
    unique("unique_provider_name_workspace").on(t.workspaceId, t.name),
  ],
);

export const workspace = pgTable(
  "workspace",
  (t) => ({
    id: t.text("id").primaryKey(),
    organizationId: t
      .text("organization_id")
      .notNull()
      .references(() => organization.id, {
        onDelete: "cascade",
      }),
    ownerId: t
      .text("owner_id")
      .notNull()
      .references(() => user.id, {
        onDelete: "cascade",
      }),
    name: t.text("name").notNull(),
    context: t.text("context"),
    taskModelProviderId: t
      .text("task_model_provider_id")
      .references(() => provider.id, {
        onDelete: "set null",
      }),

    // Memory extraction configuration (null = disabled, non-null = enabled)
    memoryExtractionProviderId: t
      .text("memory_extraction_provider_id")
      .references(() => provider.id, { onDelete: "set null" }),

    // Memory embedding configuration
    memoryEmbeddingProviderId: t
      .text("memory_embedding_provider_id")
      .references(() => provider.id, { onDelete: "set null" }),
    maxDailySummaries: t.integer("max_daily_summaries").default(90),

    // Per-workspace delegation flags (ADR-0006). When true, the workspace
    // owner may self-manage the respective credential/reach-bearing resource
    // without org-admin. Settable only by an org admin. Default false.
    providerSelfManagement: t
      .boolean("provider_self_management")
      .notNull()
      .default(false),
    mcpSelfManagement: t
      .boolean("mcp_self_management")
      .notNull()
      .default(false),
    // Whether this Workspace's Inbound Triggers are reachable while the
    // Organization's gate is "selected" (ADR-0030). Org Admin-only, like the
    // delegation flags above; ignored under "off" and "all".
    inboundTriggersAllowed: t
      .boolean("inbound_triggers_allowed")
      .notNull()
      .default(false),
    // Whether this Workspace's A2A endpoints are reachable while the
    // Organization's A2A gate is "selected" (ADR-0032). Org Admin-only.
    a2aAllowed: t.boolean("a2a_allowed").notNull().default(false),

    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_workspace_organization_id").on(t.organizationId),
    index("idx_workspace_owner_id").on(t.ownerId),
    index("idx_workspace_task_model_provider_id").on(t.taskModelProviderId),
    index("idx_workspace_memory_extraction_provider_id").on(
      t.memoryExtractionProviderId,
    ),
    index("idx_workspace_memory_embedding_provider_id").on(
      t.memoryEmbeddingProviderId,
    ),
  ],
);

export const chat = pgTable(
  "chat",
  (t) => ({
    id: t.text("id").primaryKey(),
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, {
        onDelete: "cascade",
      }),
    title: t.text("title").notNull(),
    // The last message of the Chat's Active path (ADR-0026): the path is read
    // by walking `parentId` up from here. Null for a Chat with no messages.
    activeLeafId: t.text("active_leaf_id"),
    // Run lifecycle status. Existing rows backfill to "succeeded" — every
    // chat row pre-status was the result of a completed run.
    status: t.text("status").notNull().default("succeeded"),
    isPinned: t.boolean("is_pinned").notNull().default(false),
    tags: t.jsonb("tags").$type<string[]>().default([]),
    agentId: t.text("agent_id"),
    providerId: t.text("provider_id"),
    modelId: t.text("model_id"),
    // The user's own instructions for an agentless chat — the first fragment of
    // the system prompt Platypus composes, never the composed prompt itself
    // (issue #365).
    instructions: t.text("instructions"),
    temperature: t.real("temperature"),
    topP: t.real("top_p"),
    topK: t.real("top_k"),
    seed: t.real("seed"),
    presencePenalty: t.real("presence_penalty"),
    frequencyPenalty: t.real("frequency_penalty"),
    // The per-chat Max steps setting for Direct (no-Agent) turns (#539),
    // mirroring the Agent table's column. Nullable: null means "unset" and
    // the turn falls back to DEFAULT_DIRECT_MAX_STEPS.
    maxSteps: t.integer("max_steps"),

    // Memory processing tracking
    lastMemoryProcessedAt: t.timestamp("last_memory_processed_at"),
    memoryExtractionStatus: t
      .text("memory_extraction_status")
      .default("pending"), // "pending" | "processing" | "completed" | "failed"
    // The last Active-path message a successful extraction pass included: the
    // next pass reads only what follows it, with what came before as context.
    // Null until a pass succeeds.
    memoryCursorId: t.text("memory_cursor_id"),

    // The pinned Memories block (ADR-0020): the rendered summaries fragment,
    // snapshotted here while the Chat is active and re-taken only when the gap
    // since the previous turn exceeds the re-pin horizon. An internal column —
    // absent from the Chat response schema, never surfaced in the product and
    // never editable. One fragment's rendered text, NOT a full system prompt
    // composite (ADR-0016 / issue #373).
    memorySnapshot: t.text("memory_snapshot"),

    // The wall-clock start of the most recent turn, written ONLY by the run
    // sink at turn boundaries. ADR-0020 measures the Chat's idle gap against
    // this, never against `updatedAt` — which the memory-extraction job and
    // auto-titling bump at their own cadence, so a background write must not
    // masquerade as a recent turn and defer a legitimate re-pin. A separate,
    // dedicated signal is the only writer-free answer.
    lastTurnAt: t.timestamp("last_turn_at"),

    // When the instance running this Chat's turn last said it is still alive
    // (`runs/chat-run-heartbeat.ts`). A `running` Chat whose heartbeat has
    // gone stale lost its run to a crash or a deploy: the next claim takes it,
    // and the recovery sweep marks it failed. Null on a Chat that has never
    // run since the column was added.
    runHeartbeatAt: t.timestamp("run_heartbeat_at"),

    // The A2A token whose client started this Chat (ADR-0032), so a retried
    // message finds its Chat. Null for a Chat started in the UI.
    a2aTokenId: t
      .text("a2a_token_id")
      .references((): AnyPgColumn => a2aToken.id, { onDelete: "set null" }),
    // That token's name when the Chat started, the client label the Chat
    // list shows. Copied rather than joined so it outlives the token.
    a2aClientName: t.text("a2a_client_name"),
    // The A2A endpoint that started this Chat, whose `extractMemories` decides
    // whether memory extraction reads it. No foreign key: the id outlives a
    // deleted endpoint, so its Chats stay out of extraction rather than
    // falling back to looking like the Owner's own.
    a2aEndpointId: t.text("a2a_endpoint_id"),

    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_chat_workspace_id").on(t.workspaceId),
    // A retried A2A message is found among the Chats its token started.
    index("idx_chat_a2a_token_id").on(t.a2aTokenId),
    index("idx_chat_tags").using("gin", t.tags),
    index("idx_chat_memory_processing").on(
      t.memoryExtractionStatus,
      t.lastMemoryProcessedAt,
      t.updatedAt,
    ),
    // NO ACTION rather than a cascade or set-null, for the leaf and the memory
    // cursor alike: a message row is never hard-deleted on its own, only with
    // its Chat, so neither can dangle.
    foreignKey({
      columns: [t.id, t.activeLeafId],
      foreignColumns: [chatMessage.chatId, chatMessage.id],
    }),
    foreignKey({
      columns: [t.id, t.memoryCursorId],
      foreignColumns: [chatMessage.chatId, chatMessage.id],
    }),
  ],
);

/**
 * One message of a Chat (ADR-0026). The messages form a tree through
 * `parentId`; the Chat's `activeLeafId` picks the Active path through it.
 *
 * Rows are never hard-deleted on their own: Delete sets `deletedAt`, which
 * takes the row off the Active path and leaves the tree's shape alone. Only the
 * Chat's own delete removes them, by cascade.
 */
export const chatMessage = pgTable(
  "chat_message",
  (t) => ({
    chatId: t
      .text("chat_id")
      .notNull()
      .references((): AnyPgColumn => chat.id, { onDelete: "cascade" }),
    // Client-generated for a user message, so unique only within its Chat.
    id: t.text("id").notNull(),
    // Null for a message that opens the Chat.
    parentId: t.text("parent_id"),
    role: t.text("role").$type<"user" | "assistant">().notNull(),
    parts: t.jsonb("parts").notNull(),
    metadata: t.jsonb("metadata"),
    deletedAt: t.timestamp("deleted_at"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    primaryKey({ columns: [t.chatId, t.id] }),
    // The parent check on a message delete; the primary key leads with
    // `chat_id` alone, which matches every message of the Chat.
    index("idx_chat_message_chat_id_parent_id").on(t.chatId, t.parentId),
    foreignKey({
      columns: [t.chatId, t.parentId],
      foreignColumns: [t.chatId, t.id],
    }),
  ],
);

export const agent = pgTable(
  "agent",
  (t) => ({
    id: t.text("id").primaryKey(),
    // An Agent is scoped to either an Organization or a Workspace (mutually
    // exclusive), mirroring the dual-scope shape of `provider`/`mcp`/`skill`.
    // Org-scoped Agents are Shared resources managed by Org Admins (ADR-0007);
    // the XOR is enforced in the Zod schema and by the routes/Promote action.
    organizationId: t
      .text("organization_id")
      .references(() => organization.id, {
        onDelete: "cascade",
      }),
    workspaceId: t.text("workspace_id").references(() => workspace.id, {
      onDelete: "cascade",
    }),
    providerId: t
      .text("provider_id")
      .notNull()
      .references(() => provider.id, {
        onDelete: "restrict",
      }),
    name: t.text("name").notNull(),
    description: t.text("description").notNull(),
    // The agent author's own instructions — the first fragment of the composed
    // system prompt, not the composite (see ./system-prompt.ts).
    instructions: t.text("instructions"),
    modelId: t.text("model_id").notNull(),
    maxSteps: t.integer("max_steps"),
    temperature: t.real("temperature"),
    topP: t.real("top_p"),
    topK: t.real("top_k"),
    seed: t.real("seed"),
    presencePenalty: t.real("presence_penalty"),
    frequencyPenalty: t.real("frequency_penalty"),
    toolSetIds: t.jsonb("tool_set_ids").$type<string[]>().default([]), // Array of tool set ids
    skillIds: t.jsonb("skill_ids").$type<string[]>().default([]), // Array of skill ids
    subAgentIds: t.jsonb("sub_agent_ids").$type<string[]>().default([]), // Array of sub-agent ids
    inputPlaceholder: t.text("input_placeholder"),
    avatarKey: t.text("avatar_key"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_agent_workspace_id").on(t.workspaceId),
    index("idx_agent_organization_id").on(t.organizationId),
    index("idx_agent_provider_id").on(t.providerId),
    // Shared Agents must have unique names within an Organization so Promote
    // surfaces a clean conflict. Workspace Agent names stay unconstrained.
    unique("unique_agent_name_org").on(t.organizationId, t.name),
  ],
);

export const mcp = pgTable(
  "mcp",
  (t) => ({
    id: t.text("id").primaryKey(),
    // An MCP is scoped to either an Organization or a Workspace (mutually
    // exclusive), mirroring the dual-scope shape of `provider`. Org-scoped MCPs
    // are Shared resources managed by Org Admins (ADR-0007); the XOR is enforced
    // in the Zod schema and by the create routes.
    organizationId: t
      .text("organization_id")
      .references(() => organization.id, {
        onDelete: "cascade",
      }),
    workspaceId: t.text("workspace_id").references(() => workspace.id, {
      onDelete: "cascade",
    }),
    name: t.text("name").notNull(),
    // Derived from `name` via `slugifyMcpName` (issue #467): the namespace
    // prefix an MCP's tools carry into a turn's tool map, so a collision with a
    // built-in or another MCP's tool cannot arise from raw server-side names.
    slug: t.text("slug").notNull(),
    url: t.text("url"),
    headers: t.jsonb("headers").$type<Record<string, string>>(),
    authType: t.text("auth_type").notNull(),
    bearerToken: t.text("bearer_token"),
    oauthAccessToken: t.text("oauth_access_token"),
    oauthRefreshToken: t.text("oauth_refresh_token"),
    oauthTokenExpiresAt: t.timestamp("oauth_token_expires_at"),
    // Granted scope returned by the token endpoint after authorization.
    oauthScope: t.text("oauth_scope"),
    // Scope sent to the authorize endpoint; some providers (e.g. Google) reject /authorize without it.
    oauthRequestedScope: t.text("oauth_requested_scope"),
    oauthClientId: t.text("oauth_client_id"),
    oauthClientSecret: t.text("oauth_client_secret"),
    // The Last-known tool listing (ADR-0029, issue #635): the raw `tools/list`
    // result of the most recent successful fetch, served when a turn's fetch
    // fails. `json`, not `jsonb` — `jsonb` re-sorts object keys, and the served
    // tools must serialise byte-identical to the live ones.
    lastKnownToolListing: t
      .json("last_known_tool_listing")
      .$type<ListToolsResult>(),
    lastKnownToolListingFetchedAt: t.timestamp(
      "last_known_tool_listing_fetched_at",
    ),
    // When a turn's fetch, or a stale tool's lazy connect, last failed (issue
    // #1105). Within a minute of it a turn serves the listing above without
    // trying the fetch (ADR-0031); null once the server answers again.
    lastFetchFailedAt: t.timestamp("last_fetch_failed_at"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_mcp_workspace_id").on(t.workspaceId),
    index("idx_mcp_organization_id").on(t.organizationId),
    unique("unique_mcp_name_org").on(t.organizationId, t.name),
    unique("unique_mcp_name_workspace").on(t.workspaceId, t.name),
    // Same-scope slug uniqueness (issue #467), mirroring the name constraints
    // above. Cross-scope collisions (an org-scoped and a workspace-scoped MCP
    // sharing a slug) are legal — they cannot both be a DB constraint since
    // they differ in which scope column is set — and are instead checked at
    // create/update time and backstopped at Chat-turn time.
    unique("unique_mcp_slug_org").on(t.organizationId, t.slug),
    unique("unique_mcp_slug_workspace").on(t.workspaceId, t.slug),
  ],
);

export const mcpOauthState = pgTable(
  "mcp_oauth_state",
  (t) => ({
    id: t.text("id").primaryKey(),
    mcpId: t
      .text("mcp_id")
      .notNull()
      .references(() => mcp.id, { onDelete: "cascade" }),
    codeVerifier: t.text("code_verifier").notNull(),
    redirectUri: t.text("redirect_uri").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    expiresAt: t.timestamp("expires_at").notNull(),
  }),
  (t) => [index("idx_mcp_oauth_state_mcp_id").on(t.mcpId)],
);

// Attachment — the explicit reference that makes an Organization-scoped Shared
// resource appear inside a specific Workspace (ADR-0007). Polymorphic by design:
// `resourceType` + `resourceId` point at an org-scoped resource (today an `mcp`
// or `provider`; extensible to Agents/Skills and Blueprints). `resourceId` has no
// FK — the relationship is enforced in application code, and deletion of a Shared
// resource is blocked while any Attachment exists rather than cascaded. The
// `workspace_id` FK cascades so a deleted Workspace drops its attachments.
export const attachment = pgTable(
  "attachment",
  (t) => ({
    id: t.text("id").primaryKey(),
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    resourceType: t
      .text("resource_type")
      .$type<"mcp" | "provider" | "skill" | "agent">()
      .notNull(),
    resourceId: t.text("resource_id").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_attachment_workspace").on(t.workspaceId, t.resourceType),
    // Drives the deletion guard ("is this resource attached anywhere?")
    index("idx_attachment_resource").on(t.resourceType, t.resourceId),
    unique("unique_attachment").on(t.workspaceId, t.resourceType, t.resourceId),
  ],
);

// Blueprint — a named, Organization-scoped macro that, applied to a Workspace,
// creates the Attachments for a chosen set of Shared resources in one step
// (ADR-0008). It is a snapshot, not a living binding: applying stamps
// Attachments at that moment; later edits never disturb already-provisioned
// Workspaces. Blueprints are always org-scoped (no dual scope) and managed only
// by Org Admins.
export const blueprint = pgTable(
  "blueprint",
  (t) => ({
    id: t.text("id").primaryKey(),
    organizationId: t
      .text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: t.text("name").notNull(),
    description: t.text("description"),

    // Tier 2 pointer-settings (ADR-0008): the Workspace settings a Blueprint
    // stamps on apply, mirroring the Workspace's own columns. All three provider
    // references must be org-scoped (Shared) — enforced in the route. `context`
    // is the default Workspace context text. Deleting a referenced provider sets
    // these null (SET NULL), matching the Workspace's pointer-setting behavior;
    // the blueprint_item deletion guard does not cover Tier 2 references.
    taskModelProviderId: t
      .text("task_model_provider_id")
      .references(() => provider.id, { onDelete: "set null" }),
    memoryExtractionProviderId: t
      .text("memory_extraction_provider_id")
      .references(() => provider.id, { onDelete: "set null" }),
    memoryEmbeddingProviderId: t
      .text("memory_embedding_provider_id")
      .references(() => provider.id, { onDelete: "set null" }),
    context: t.text("context"),

    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_blueprint_organization_id").on(t.organizationId),
    index("idx_blueprint_task_model_provider_id").on(t.taskModelProviderId),
    index("idx_blueprint_memory_extraction_provider_id").on(
      t.memoryExtractionProviderId,
    ),
    index("idx_blueprint_memory_embedding_provider_id").on(
      t.memoryEmbeddingProviderId,
    ),
    unique("unique_blueprint_name_org").on(t.organizationId, t.name),
  ],
);

// The Shared resources a Blueprint provisions. Mirrors `attachment`: polymorphic
// `resourceType` + `resourceId` pointing at an org-scoped resource, no FK on
// `resourceId` (the relationship is enforced in application code, and deletion
// of a Shared resource is blocked while any Blueprint lists it rather than
// cascaded). The `blueprint_id` FK cascades so deleting a Blueprint drops its
// items.
export const blueprintItem = pgTable(
  "blueprint_item",
  (t) => ({
    id: t.text("id").primaryKey(),
    blueprintId: t
      .text("blueprint_id")
      .notNull()
      .references(() => blueprint.id, { onDelete: "cascade" }),
    resourceType: t
      .text("resource_type")
      .$type<"mcp" | "provider" | "skill" | "agent">()
      .notNull(),
    resourceId: t.text("resource_id").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_blueprint_item_blueprint").on(t.blueprintId),
    // Drives the extended deletion guard ("is this resource listed in any
    // Blueprint?")
    index("idx_blueprint_item_resource").on(t.resourceType, t.resourceId),
    unique("unique_blueprint_item").on(
      t.blueprintId,
      t.resourceType,
      t.resourceId,
    ),
  ],
);

export const sandbox = pgTable(
  "sandbox",
  (t) => ({
    id: t.text("id").primaryKey(),
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, {
        onDelete: "cascade",
      }),
    name: t.text("name").notNull(),
    backend: t.text("backend").notNull(),
    config: t
      .jsonb("config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    credentials: t
      .jsonb("credentials")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    // Workspace-default env split into two precedence tiers (ADR-0004 amendment,
    // ADR-0006): adminEnv is org-admin-managed and wins; userEnv is
    // workspace-owner-managed. Merge order at exec: adminEnv ▸ userEnv ▸
    // model-provided input.env.
    adminEnv: t
      .jsonb("admin_env")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    userEnv: t
      .jsonb("user_env")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [uniqueIndex("unique_sandbox_workspace_id").on(t.workspaceId)],
);

// Records sandbox destroy() failures so operators can reconcile leaked external
// resources out-of-band. workspace_id is intentionally NOT a foreign key — the
// table must survive Workspace deletion (see ADR-0001 cascade contract).
export const sandboxTeardownFailure = pgTable(
  "sandbox_teardown_failure",
  (t) => ({
    id: t.text("id").primaryKey(),
    workspaceId: t.text("workspace_id").notNull(),
    backend: t.text("backend").notNull(),
    config: t.jsonb("config").$type<Record<string, unknown>>().notNull(),
    error: t.text("error").notNull(),
    attemptedAt: t.timestamp("attempted_at").notNull().defaultNow(),
  }),
  (t) => [index("idx_sandbox_teardown_failure_workspace_id").on(t.workspaceId)],
);

// Organization membership - links users to organizations with roles
export const organizationMember = pgTable(
  "organization_member",
  (t) => ({
    id: t.text("id").primaryKey(),
    organizationId: t
      .text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: t
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: t.text("role").notNull().default("member"), // admin | member
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_org_member_org_id").on(t.organizationId),
    index("idx_org_member_user_id").on(t.userId),
    unique("unique_org_member_org_user").on(t.organizationId, t.userId),
  ],
);

// Invitations for organization membership
export const invitation = pgTable(
  "invitation",
  (t) => ({
    id: t.text("id").primaryKey(),
    email: t.text("email").notNull(),
    organizationId: t
      .text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Null once the inviter's account is deleted: the invitation stays
    // redeemable, it just no longer names who sent it.
    invitedBy: t
      .text("invited_by")
      .references(() => user.id, { onDelete: "set null" }),
    status: t.text("status").notNull().default("pending"), // pending | accepted | declined | expired
    // Optional name for the Workspace provisioned on accept (ADR-0008). Null
    // defaults to "<member name>'s Workspace" at accept time.
    workspaceName: t.text("workspace_name"),
    // Redemption token minted with the invitation (ADR-0019, #549): a
    // URL-safe, unguessable string that lets someone without an account yet
    // resolve and redeem the invitation via its link rather than only after
    // they already hold an account with the invited address. Plaintext and re-copyable by design (ADR-0019): there
    // is no rotation action, and Platypus has no email to re-send a
    // show-once secret through. Every insert sets this explicitly (the
    // create handler mints it, same as `id`); it stays nullable at the
    // column level only so backfilling pre-existing rows is a plain data
    // migration rather than a multi-step NOT NULL dance.
    token: t.text("token"),
    expiresAt: t.timestamp("expires_at").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_invitation_email").on(t.email),
    index("idx_invitation_org_id").on(t.organizationId),
    index("idx_invitation_invited_by").on(t.invitedBy),
    // Partial: only a pending invitation claims the address (#1131), so an
    // accepted, declined or expired one never blocks re-inviting it.
    uniqueIndex("unique_invitation_org_email")
      .on(t.organizationId, t.email)
      .where(sql`${t.status} = 'pending'`),
    unique("unique_invitation_token").on(t.token),
  ],
);

// The ordered set of Blueprints an invitation carries (ADR-0009). On accept,
// each Blueprint's macro runs in `position` order against the freshly
// provisioned Workspace. Mirrors `blueprint_item`: `position` makes order
// first-class, and the real `blueprint_id` FK powers the deletion guard
// (a Blueprint cannot be deleted while a live pending invitation references it).
// Both FKs cascade — deleting an invitation or a (legitimately deletable)
// Blueprint cleans up the junction rows.
export const invitationBlueprint = pgTable(
  "invitation_blueprint",
  (t) => ({
    id: t.text("id").primaryKey(),
    invitationId: t
      .text("invitation_id")
      .notNull()
      .references(() => invitation.id, { onDelete: "cascade" }),
    blueprintId: t
      .text("blueprint_id")
      .notNull()
      .references(() => blueprint.id, { onDelete: "cascade" }),
    position: t.integer("position").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_invitation_blueprint_invitation").on(t.invitationId),
    // Drives the deletion guard ("is this Blueprint referenced by an invite?")
    index("idx_invitation_blueprint_blueprint").on(t.blueprintId),
    unique("unique_invitation_blueprint").on(t.invitationId, t.blueprintId),
  ],
);

export const skill = pgTable(
  "skill",
  (t) => ({
    id: t.text("id").primaryKey(),
    // A Skill is scoped to either an Organization or a Workspace (mutually
    // exclusive), mirroring the dual-scope shape of `provider`/`mcp`. Org-scoped
    // Skills are Shared resources managed by Org Admins (ADR-0007); the XOR is
    // enforced in the Zod schema and by the create routes.
    organizationId: t
      .text("organization_id")
      .references(() => organization.id, {
        onDelete: "cascade",
      }),
    workspaceId: t.text("workspace_id").references(() => workspace.id, {
      onDelete: "cascade",
    }),
    name: t.text("name").notNull(),
    description: t.text("description").notNull(),
    body: t.text("body").notNull(),
    disableModelInvocation: t
      .boolean("disable_model_invocation")
      .notNull()
      .default(false),
    argumentHint: t.text("argument_hint"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_skill_workspace_id").on(t.workspaceId),
    index("idx_skill_organization_id").on(t.organizationId),
    unique("unique_skill_name_workspace").on(t.workspaceId, t.name),
    unique("unique_skill_name_org").on(t.organizationId, t.name),
  ],
);

export const context = pgTable(
  "context",
  (t) => ({
    id: t.text("id").primaryKey(),
    userId: t
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: t
      .text("workspace_id")
      .references(() => workspace.id, { onDelete: "cascade" }),
    content: t.text("content").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_context_user_id").on(t.userId),
    index("idx_context_workspace_id").on(t.workspaceId),
    // A global Context has a null workspace_id; nulls must collide so a
    // user holds at most one global Context.
    unique("unique_context_user_workspace")
      .on(t.userId, t.workspaceId)
      .nullsNotDistinct(),
  ],
);

export const memoryDailySummary = pgTable(
  "memory_daily_summary",
  (t) => ({
    id: t.text("id").primaryKey(),
    userId: t
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    summaryDate: t.date("summary_date").notNull(),
    summary: t.text("summary").notNull(),
    embedding: unboundVector("embedding"), // No fixed dimensions — configurable per workspace
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    unique("unique_daily_summary_user_workspace_date").on(
      t.userId,
      t.workspaceId,
      t.summaryDate,
    ),
    index("idx_daily_summary_user_workspace").on(t.userId, t.workspaceId),
    index("idx_daily_summary_date").on(t.summaryDate),
    index("idx_daily_summary_workspace_id").on(t.workspaceId),
    // No HNSW index — dimensions vary per workspace. Exact nearest-neighbor
    // search via <=> is fast enough for the scale of daily summaries (hundreds
    // to low thousands of rows per workspace). Queries are already scoped by
    // userId + workspaceId which narrows the search set significantly.
  ],
);

export const trigger = pgTable(
  "trigger",
  (t) => ({
    id: t.text("id").primaryKey(),
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    agentId: t
      .text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "restrict" }),
    type: t.text("type").notNull(), // "cron" | "event" | "inbound"
    name: t.text("name").notNull(),
    description: t.text("description"),
    instruction: t.text("instruction").notNull(),
    enabled: t.boolean("enabled").notNull().default(true),
    maxRunsToKeep: t.integer("max_runs_to_keep").notNull().default(10),
    search: t.boolean("search").notNull().default(false),
    // Off by default, and deliberately not backfilled (#645): a headless run
    // should not have a system prompt that drifts with interactive-chat
    // activity unrelated to it. Existing Triggers stop composing the
    // `<memories>` block when this column lands — the intended outcome.
    includeMemories: t.boolean("include_memories").notNull().default(false),
    config: t.jsonb("config").notNull(),
    lastRunAt: t.timestamp("last_run_at"),
    nextRunAt: t.timestamp("next_run_at"),
    // Inbound Triggers only (ADR-0030). The token is shown once and stored as
    // a SHA-256 hash — it is 256 random bits, so a slow hash buys nothing. Null
    // on other types, and on an Inbound Trigger whose token was revoked.
    tokenHash: t.text("token_hash"),
    tokenCreatedAt: t.timestamp("token_created_at"),
    tokenExpiresAt: t.timestamp("token_expires_at"),
    // The latest expiry Notification sent for the current token: null |
    // "expiring_30" | "expiring_7" | "expired". The three are sent in that
    // order, so one ordered value records all of them. Kept here rather than
    // inferred from the Notification, which the Owner may delete; issuing or
    // revoking a token clears it.
    tokenNotice: t.text("token_notice"),
    // Written at most once a minute per Trigger, so a flood of calls cannot
    // become a flood of writes.
    lastUsedAt: t.timestamp("last_used_at"),
    lastRejectedAt: t.timestamp("last_rejected_at"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_trigger_workspace_id").on(t.workspaceId),
    index("idx_trigger_next_run_at").on(t.nextRunAt),
    index("idx_trigger_type").on(t.type),
    index("idx_trigger_agent_id").on(t.agentId),
  ],
);

export const triggerRun = pgTable(
  "trigger_run",
  (t) => ({
    id: t.text("id").primaryKey(),
    triggerId: t
      .text("trigger_id")
      .notNull()
      .references(() => trigger.id, { onDelete: "cascade" }),
    // pending | running | success | failed | cancelled | suppressed
    status: t.text("status").notNull().default("pending"),
    eventType: t.text("event_type"),
    eventData: t.jsonb("event_data"),
    // The entity an Event Trigger's event named — the Card or Notification the
    // run was for. Null on Cron runs, on rows written before the column
    // existed, and on events that name no single entity (bulk
    // `notification.read`); the run-rate breaker counts by this column and
    // ignores null, so those firings are exempt by construction. An Inbound
    // Trigger run always carries one: its record key's value, or the Trigger's
    // own id when no key is marked, so every inbound run is under the breaker.
    entityId: t.text("entity_id"),
    startedAt: t.timestamp("started_at").notNull().defaultNow(),
    completedAt: t.timestamp("completed_at"),
    errorMessage: t.text("error_message"),
    stats: t.jsonb("stats"),
    // The final assistant text — "what did it conclude" — one value per run
    // (#647, ADR-0023). Null until the run has one, and for ever on runs that
    // predate the column or ended before answering. The runs LIST never
    // selects it; only the run detail does.
    finalText: t.text("final_text"),
    // The run's timeline hit the per-run event ceiling, so `trigger_run_event`
    // holds a prefix of what happened rather than all of it.
    eventsTruncated: t.boolean("events_truncated").notNull().default(false),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_trigger_run_trigger_id").on(t.triggerId),
    index("idx_trigger_run_started_at").on(t.startedAt),
    // The run-rate breaker's per-(Trigger, entity) count over its rolling window,
    // and the retention union that keeps that window countable. Column order
    // matches the predicate: exact Trigger, exact entity, range on time.
    index("idx_trigger_run_trigger_entity_started_at").on(
      t.triggerId,
      t.entityId,
      t.startedAt,
    ),
  ],
);

// Kanban Board

export const kanbanBoard = pgTable(
  "kanban_board",
  (t) => ({
    id: t.text("id").primaryKey(),
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: t.text("name").notNull(),
    description: t.text("description"),
    labels: t
      .jsonb("labels")
      .$type<{ id: string; name: string; color: string }[]>()
      .notNull()
      .default([]),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_kanban_board_workspace_id").on(t.workspaceId),
    unique("unique_kanban_board_name_workspace").on(t.workspaceId, t.name),
  ],
);

export const kanbanColumn = pgTable(
  "kanban_column",
  (t) => ({
    id: t.text("id").primaryKey(),
    boardId: t
      .text("board_id")
      .notNull()
      .references(() => kanbanBoard.id, { onDelete: "cascade" }),
    name: t.text("name").notNull(),
    position: t.real("position").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [index("idx_kanban_column_board_id").on(t.boardId)],
);

export const kanbanCard = pgTable(
  "kanban_card",
  (t) => ({
    id: t.text("id").primaryKey(),
    columnId: t
      .text("column_id")
      .notNull()
      .references(() => kanbanColumn.id, { onDelete: "cascade" }),
    title: t.text("title").notNull(),
    body: t.text("body"),
    labelIds: t.jsonb("label_ids").$type<string[]>().notNull().default([]),
    assignees: t
      .jsonb("assignees")
      .$type<{ type: "user" | "agent"; id: string }[]>()
      .notNull()
      .default([]),
    dueDate: t.timestamp("due_date"),
    priority: t
      .text("priority")
      .$type<"none" | "low" | "medium" | "high" | "urgent">()
      .notNull()
      .default("none"),
    position: t.real("position").notNull(),
    createdByUserId: t
      .text("created_by_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    createdByAgentId: t
      .text("created_by_agent_id")
      .references(() => agent.id, { onDelete: "set null" }),
    lastEditedByUserId: t
      .text("last_edited_by_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    lastEditedByAgentId: t
      .text("last_edited_by_agent_id")
      .references(() => agent.id, { onDelete: "set null" }),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_kanban_card_column_id").on(t.columnId),
    index("idx_kanban_card_label_ids").using("gin", t.labelIds),
    index("idx_kanban_card_assignees").using("gin", t.assignees),
    index("idx_kanban_card_due_date").on(t.dueDate),
    index("idx_kanban_card_priority").on(t.priority),
    index("idx_kanban_card_column_position").on(t.columnId, t.position),
    index("idx_kanban_card_created_by_user_id").on(t.createdByUserId),
    index("idx_kanban_card_created_by_agent_id").on(t.createdByAgentId),
    index("idx_kanban_card_last_edited_by_user_id").on(t.lastEditedByUserId),
    index("idx_kanban_card_last_edited_by_agent_id").on(t.lastEditedByAgentId),
  ],
);

/**
 * A **Run event**: one thing that happened during a Trigger run — a tool call,
 * a stretch of reasoning, a stretch of text, or a delegation — with when it
 * started, how long it took and how it ended, and never what it said (#647,
 * ADR-0023). Together, a run's rows are its **Run timeline**.
 *
 * A table rather than a JSONB column on the run because of concurrency: a run
 * that fans out to parallel Sub-Agents has several delegates appending to one
 * timeline at once, and a read-modify-write on a shared array loses updates.
 * Independent inserts make that the database's problem.
 *
 * Every event keys to the ROOT run, however deep the delegation it belongs to,
 * so the run's cascade — and with it Max Runs to Keep retention — removes the
 * whole timeline. Nesting is the self-referencing `parentEventId`: null for an
 * event of the root run, the `delegate` event's id for an event of that
 * delegate's run. Delegates get no run record of their own.
 */
export const triggerRunEvent = pgTable(
  "trigger_run_event",
  (t) => ({
    id: t.text("id").primaryKey(),
    runId: t
      .text("run_id")
      .notNull()
      .references(() => triggerRun.id, { onDelete: "cascade" }),
    parentEventId: t
      .text("parent_event_id")
      .references((): AnyPgColumn => triggerRunEvent.id, {
        onDelete: "cascade",
      }),
    // Monotonic insertion order within the run, for incremental polling.
    // Display order is `startedAt`, so parallel tool calls read as overlapping.
    seq: t.integer("seq").notNull(),
    // tool-call | reasoning | text | delegate
    type: t.text("type").notNull(),
    toolName: t.text("tool_name"),
    // An absolute wall-clock instant in epoch milliseconds — not an offset from
    // the run's start, so it correlates with logs and a delegate's events need
    // no rebasing. Stored as the number the recorder measured.
    startedAt: t.bigint("started_at", { mode: "number" }).notNull(),
    // Measured on a monotonic clock, never as a difference of two wall-clock
    // reads. Null while the event is open — and for ever on an event the
    // stuck-run sweep closed, whose end nobody saw.
    durationMs: t.integer("duration_ms"),
    // running | completed | error | cancelled
    status: t.text("status").notNull(),
    // `{ message, truncated, originalBytes }` — the one content a Run event
    // carries, capped at 1 KB on a character boundary. Null unless it failed.
    error: t.jsonb("error"),
    childrenTruncated: t.boolean("children_truncated").notNull().default(false),
  }),
  (t) => [
    // The detail read: one run's events, incrementally past a sequence number.
    index("idx_trigger_run_event_run_id_seq").on(t.runId, t.seq),
    // Retention's cascade looks up each deleted event's children.
    index("idx_trigger_run_event_parent_event_id").on(t.parentEventId),
  ],
);

// Notifications

export const notification = pgTable(
  "notification",
  (t) => ({
    id: t.text("id").primaryKey(),
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    agentId: t
      .text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    title: t.text("title"),
    body: t.text("body").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_notification_workspace_id").on(t.workspaceId),
    index("idx_notification_agent_id").on(t.agentId),
    index("idx_notification_created_at").on(t.createdAt),
  ],
);

export const notificationRead = pgTable(
  "notification_read",
  (t) => ({
    id: t.text("id").primaryKey(),
    notificationId: t
      .text("notification_id")
      .notNull()
      .references(() => notification.id, { onDelete: "cascade" }),
    userId: t
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    readAt: t.timestamp("read_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_notification_read_user_id").on(t.userId),
    index("idx_notification_read_notification_id").on(t.notificationId),
    unique("unique_notification_read").on(t.notificationId, t.userId),
  ],
);

// Webhook (multiple per workspace)

export const webhook = pgTable(
  "webhook",
  (t) => ({
    id: t.text("id").primaryKey(),
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: t.text("name").notNull().default("Webhook"),
    url: t.text("url").notNull(),
    signingSecret: t.text("signing_secret").notNull(),
    headers: t.jsonb().$type<Record<string, string>>(),
    enabled: t.boolean("enabled").notNull().default(true),
    events: t.jsonb("events").$type<string[]>().notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [index("idx_webhook_workspace_id").on(t.workspaceId)],
);

// An Agent made reachable over A2A from one Workspace (ADR-0032). The id is
// the public, unguessable part of the URL — never the Agent's id. Deleting
// the Agent deletes its endpoints; detaching a Shared Agent deletes them in
// `detachResource`, since no foreign key sees the Attachment.
export const a2aEndpoint = pgTable(
  "a2a_endpoint",
  (t) => ({
    id: t.text("id").primaryKey(),
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    agentId: t
      .text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    // What outside callers see on the Agent Card, in place of the Agent's own.
    name: t.text("name").notNull(),
    description: t.text("description").notNull(),
    enabled: t.boolean("enabled").notNull().default(true),
    // Both off by default: the caller may not be the Owner. `includeMemories`
    // puts the Owner's Memories in a turn's System prompt and serves the
    // Agent's Memory tools, on every turn in the endpoint's Chats, the Owner's
    // own included; `extractMemories`
    // lets the endpoint's Chats feed memory extraction, UI turns included.
    includeMemories: t.boolean("include_memories").notNull().default(false),
    extractMemories: t.boolean("extract_memories").notNull().default(false),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_a2a_endpoint_workspace_id").on(t.workspaceId),
    index("idx_a2a_endpoint_agent_id").on(t.agentId),
  ],
);

// One bearer token per A2A client. Shown once and stored as a SHA-256 hash,
// as an Inbound Trigger's token is (ADR-0030).
export const a2aToken = pgTable(
  "a2a_token",
  (t) => ({
    id: t.text("id").primaryKey(),
    endpointId: t
      .text("endpoint_id")
      .notNull()
      .references(() => a2aEndpoint.id, { onDelete: "cascade" }),
    name: t.text("name").notNull(),
    tokenHash: t.text("token_hash").notNull(),
    // The current value's lifecycle, as on an Inbound Trigger (ADR-0030):
    // regenerating moves both times on and clears `tokenNotice`, the latest
    // expiry Notification sent for this value.
    tokenCreatedAt: t.timestamp("token_created_at").notNull(),
    tokenExpiresAt: t.timestamp("token_expires_at").notNull(),
    tokenNotice: t.text("token_notice"),
    // Each written at most once a minute per token.
    lastUsedAt: t.timestamp("last_used_at"),
    lastRejectedAt: t.timestamp("last_rejected_at"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [index("idx_a2a_token_endpoint_id").on(t.endpointId)],
);

/** How an A2A Task ended, as recorded when its run ended. */
export type A2aTaskEndState = "completed" | "failed" | "canceled";

// One A2A turn as a Task (ADR-0032), under a random UUID. While it runs, its
// state is derived from the Chat's run; `state` records how that run ended,
// since a Chat that moves on no longer has it. The turn is named by its user
// message — the client's `messageId` — whose reply is the assistant message.
// `canceledAt` is when a client's `CancelTask` claimed it: a run the cancel
// message missed is found and stopped from it. `statusAt` is the Task's status
// timestamp: when it was made, then when its end was recorded. `replyId` is the
// reply recorded with its end, its artifact from then on: one the Owner deletes
// or regenerates leaves the Task its state and no artifact. Lives as long as
// its Chat; an endpoint or token deleted later leaves it with no way to be read.
export const a2aTask = pgTable(
  "a2a_task",
  (t) => ({
    id: t.text("id").primaryKey(),
    chatId: t.text("chat_id").notNull(),
    messageId: t.text("message_id").notNull(),
    endpointId: t
      .text("endpoint_id")
      .references(() => a2aEndpoint.id, { onDelete: "set null" }),
    tokenId: t
      .text("token_id")
      .references(() => a2aToken.id, { onDelete: "set null" }),
    state: t.text("state").$type<A2aTaskEndState>(),
    canceledAt: t.timestamp("canceled_at"),
    statusAt: t.timestamp("status_at", { precision: 3 }).notNull().defaultNow(),
    // Push notifications sent for this Task, over every config it has had, so
    // deleting a delivered config and registering another can't send more.
    pushCount: t.integer("push_count").notNull().default(0),
    replyId: t.text("reply_id"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    uniqueIndex("idx_a2a_task_chat_id_message_id").on(t.chatId, t.messageId),
    index("idx_a2a_task_endpoint_id").on(t.endpointId),
    // A token's ListTasks page, newest status first; its leading column
    // serves the token's foreign key too. `NULLS FIRST` is what `DESC` sorts
    // by, so the page's `ORDER BY` reads straight off it.
    index("idx_a2a_task_token_id_status_at_id").on(
      t.tokenId,
      t.statusAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // A token's Tasks with no end recorded, which ListTasks reads from their
    // runs on every call.
    index("idx_a2a_task_token_id_unended")
      .on(t.tokenId)
      .where(sql`${t.state} IS NULL`),
    index("idx_a2a_task_chat_id_reply_id").on(t.chatId, t.replyId),
    // Deleted with its Chat, and never names a message the Chat lacks.
    foreignKey({
      columns: [t.chatId, t.messageId],
      foreignColumns: [chatMessage.chatId, chatMessage.id],
    }).onDelete("cascade"),
    // Its migration narrows the action to `SET NULL ("reply_id")`: the whole
    // key would null `chat_id` too, which Drizzle can't express.
    foreignKey({
      name: "a2a_task_reply_fk",
      columns: [t.chatId, t.replyId],
      foreignColumns: [chatMessage.chatId, chatMessage.id],
    }).onDelete("set null"),
  ],
);

/**
 * How an A2A client asked its push notifications to authenticate. Credentials
 * are optional, as in A2A 1.0's `AuthenticationInfo`.
 */
export type A2aPushAuthentication = { scheme: string; credentials?: string };

// Where an A2A client asked to be called when a Task ends (ADR-0032). The id
// is the client's own, unique within its Task. The credentials are the
// client's, sent back to it on delivery, so they are stored as given, like a
// Webhook's headers. `notifiedAt` claims the one delivery a config gets.
export const a2aPushConfig = pgTable(
  "a2a_push_config",
  (t) => ({
    id: t.text("id").notNull(),
    taskId: t
      .text("task_id")
      .notNull()
      .references(() => a2aTask.id, { onDelete: "cascade" }),
    url: t.text("url").notNull(),
    token: t.text("token"),
    authentication: t.jsonb("authentication").$type<A2aPushAuthentication>(),
    notifiedAt: t.timestamp("notified_at"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [primaryKey({ columns: [t.taskId, t.id] })],
);

export const kanbanCardComment = pgTable(
  "kanban_card_comment",
  (t) => ({
    id: t.text("id").primaryKey(),
    cardId: t
      .text("card_id")
      .notNull()
      .references(() => kanbanCard.id, { onDelete: "cascade" }),
    body: t.text("body").notNull(),
    createdByUserId: t
      .text("created_by_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    createdByAgentId: t
      .text("created_by_agent_id")
      .references(() => agent.id, { onDelete: "set null" }),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_kanban_card_comment_card_id").on(t.cardId),
    index("idx_kanban_card_comment_created_by_user_id").on(t.createdByUserId),
    index("idx_kanban_card_comment_created_by_agent_id").on(t.createdByAgentId),
  ],
);

/**
 * One write addressed to a Card, as its history remembers it (ADR-0024).
 * Cascades with the Card by design: a Card history is working context, so it
 * has no reason to outlive what it describes — which is also why `card.deleted`
 * is unloggable here.
 *
 * The actor is the leaf writer, taken from the `KanbanActor` the service was
 * called with and mirroring the Card's own `lastEditedBy*` columns, never the
 * ambient causation chain (ADR-0022) — that models who is responsible for a
 * run, which is a different question.
 */
export const kanbanCardHistory = pgTable(
  "kanban_card_history",
  (t) => ({
    id: t.text("id").primaryKey(),
    cardId: t
      .text("card_id")
      .notNull()
      .references(() => kanbanCard.id, { onDelete: "cascade" }),
    kind: t.text("kind").$type<"created" | "updated">().notNull(),
    changes: t
      .jsonb("changes")
      .$type<KanbanCardHistoryChange[]>()
      .notNull()
      .default([]),
    actorUserId: t
      .text("actor_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    actorAgentId: t
      .text("actor_agent_id")
      .references(() => agent.id, { onDelete: "set null" }),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    // Read newest-first for one card, and trimmed by the same key.
    index("idx_kanban_card_history_card_id_created_at").on(
      t.cardId,
      t.createdAt,
    ),
    index("idx_kanban_card_history_actor_user_id").on(t.actorUserId),
    index("idx_kanban_card_history_actor_agent_id").on(t.actorAgentId),
  ],
);

// Dashboard

export const dashboard = pgTable(
  "dashboard",
  (t) => ({
    id: t.text("id").primaryKey(),
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: t.text("name").notNull(),
    description: t.text("description"),
    desktopLayout: t
      .jsonb("desktop_layout")
      .$type<{ i: string; x: number; y: number; w: number; h: number }[]>()
      .notNull()
      .default([]),
    mobileLayout: t
      .jsonb("mobile_layout")
      .$type<{ i: string; x: number; y: number; w: number; h: number }[]>()
      .notNull()
      .default([]),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_dashboard_workspace_id").on(t.workspaceId),
    uniqueIndex("uq_dashboard_workspace_name").on(t.workspaceId, t.name),
  ],
);

export const widget = pgTable(
  "widget",
  (t) => ({
    id: t.text("id").primaryKey(),
    dashboardId: t
      .text("dashboard_id")
      .notNull()
      .references(() => dashboard.id, { onDelete: "cascade" }),
    type: t
      .text("type")
      .$type<
        | "metric"
        | "text"
        | "image"
        | "embed"
        | "weather"
        | "line-chart"
        | "pie-chart"
        | "bar-chart"
      >()
      .notNull(),
    title: t.text("title").notNull(),
    data: t.jsonb("data"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_widget_dashboard_id").on(t.dashboardId),
    uniqueIndex("uq_widget_dashboard_title").on(t.dashboardId, t.title),
  ],
);
