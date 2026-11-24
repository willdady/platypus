import {
  pgTable,
  index,
  unique,
  uniqueIndex,
  customType,
  foreignKey,
  primaryKey,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export * from "./auth-schema.ts";
import { user } from "./auth-schema.ts";
import type { z } from "zod";
import type {
  ArtifactAuthor,
  ArtifactType,
  AttachmentResourceType,
  ChatMessageMetadata,
  ChatStatus,
  EventTriggerEvent,
  EventTriggerEventPayload,
  JobSettings,
  KanbanCardAssignee,
  KanbanCardHistoryChange,
  KanbanCardPriority,
  KanbanLabel,
  ModelConfig,
  OrgGate,
  OrgRole,
  PlatypusUIMessage,
  Provider,
  providerApiModeSchema,
  ReasoningEffort,
  RunEventError,
  ModelSwitch,
  RunEventStatus,
  RunEventType,
  TranscriptSummaryStats,
  TriggerRunStats,
  TriggerRunStatus,
  triggerSchema,
  TriggerType,
  UnloadedToolSet,
} from "@platypus/schemas";
import type {
  ListToolsResult,
  OAuthAuthorizationServerInformation,
} from "@ai-sdk/mcp";

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

export const organization = pgTable(
  "organization",
  (t) => ({
    id: t.text("id").primaryKey(),
    name: t.text("name").notNull(),
    identityContext: t.text("identity_context"),
    inboundTriggerGate: t
      .text("inbound_trigger_gate")
      .$type<OrgGate>()
      .notNull()
      .default("off"),
    a2aGate: t.text("a2a_gate").$type<OrgGate>().notNull().default("off"),
    skillImportGate: t
      .text("skill_import_gate")
      .$type<OrgGate>()
      .notNull()
      .default("all"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    check(
      "organization_inbound_trigger_gate_allowed",
      sql`${t.inboundTriggerGate} in ('off', 'all', 'selected')`,
    ),
    check(
      "organization_a2a_gate_allowed",
      sql`${t.a2aGate} in ('off', 'all', 'selected')`,
    ),
    check(
      "organization_skill_import_gate_allowed",
      sql`${t.skillImportGate} in ('off', 'all', 'selected')`,
    ),
  ],
);

export const provider = pgTable(
  "provider",
  (t) => ({
    id: t.text("id").primaryKey(),
    organizationId: t
      .text("organization_id")
      .references(() => organization.id, {
        onDelete: "cascade",
      }),
    workspaceId: t
      .text("workspace_id")
      .references((): AnyPgColumn => workspace.id, {
        onDelete: "cascade",
      }),
    name: t.text("name").notNull(),
    providerType: t
      .text("provider_type")
      .$type<Provider["providerType"]>()
      .notNull(),
    apiKey: t.text("api_key").notNull(),
    region: t.text("region"),
    baseUrl: t.text("base_url"),
    headers: t.jsonb().$type<Record<string, string>>(),
    extraBody: t.jsonb().$type<Record<string, unknown>>(),
    organization: t.text("organization"),
    project: t.text("project"),
    apiMode: t
      .text("api_mode")
      .$type<z.infer<typeof providerApiModeSchema>>()
      .notNull()
      .default("responses"),
    searchSource: t.text("search_source").notNull().default("native"),
    securityGuardrails: t.text("security_guardrails"),
    modelIds: t.jsonb().$type<ModelConfig[]>().notNull(),
    taskModelId: t.text("task_model_id").notNull(),
    memoryExtractionModelId: t.text("memory_extraction_model_id").notNull(),
    taskModelSettings: t.jsonb("task_model_settings").$type<JobSettings>(),
    memoryExtractionModelSettings: t
      .jsonb("memory_extraction_model_settings")
      .$type<JobSettings>(),
    embeddingModelId: t.text("embedding_model_id"),
    embeddingDimensions: t.integer("embedding_dimensions"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    check(
      "provider_scope_exclusive",
      sql`(${t.organizationId} is null) <> (${t.workspaceId} is null)`,
    ),
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

    memoryExtractionProviderId: t
      .text("memory_extraction_provider_id")
      .references(() => provider.id, { onDelete: "set null" }),

    memoryEmbeddingProviderId: t
      .text("memory_embedding_provider_id")
      .references(() => provider.id, { onDelete: "set null" }),
    maxDailySummaries: t.integer("max_daily_summaries").notNull().default(90),

    providerSelfManagement: t
      .boolean("provider_self_management")
      .notNull()
      .default(false),
    mcpSelfManagement: t
      .boolean("mcp_self_management")
      .notNull()
      .default(false),
    inboundTriggersAllowed: t
      .boolean("inbound_triggers_allowed")
      .notNull()
      .default(false),
    a2aAllowed: t.boolean("a2a_allowed").notNull().default(false),
    skillImportAllowed: t
      .boolean("skill_import_allowed")
      .notNull()
      .default(false),

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
    activeLeafId: t.text("active_leaf_id"),
    status: t.text("status").$type<ChatStatus>().notNull().default("succeeded"),
    isPinned: t.boolean("is_pinned").notNull().default(false),
    titleFailures: t.integer("title_failures").notNull().default(0),
    // why: no FK; a dangling id is how the Chat shows its Agent or Provider is gone
    agentId: t.text("agent_id"),
    providerId: t.text("provider_id"),
    modelId: t.text("model_id"),
    instructions: t.text("instructions"),
    temperature: t.real("temperature"),
    topP: t.real("top_p"),
    topK: t.real("top_k"),
    seed: t.real("seed"),
    presencePenalty: t.real("presence_penalty"),
    frequencyPenalty: t.real("frequency_penalty"),
    reasoningThinking: t.boolean("reasoning_thinking"),
    reasoningEffort: t.text("reasoning_effort").$type<ReasoningEffort>(),
    thinkingBudget: t.integer("thinking_budget"),
    maxSteps: t.integer("max_steps"),

    lastMemoryProcessedAt: t.timestamp("last_memory_processed_at"),
    memoryExtractionStatus: t
      .text("memory_extraction_status")
      .default("pending"),
    memoryCursorId: t.text("memory_cursor_id"),

    memorySnapshot: t.text("memory_snapshot"),

    // why: the idle gap reads this, never updatedAt, which background jobs also bump
    lastTurnAt: t.timestamp("last_turn_at"),

    runHeartbeatAt: t.timestamp("run_heartbeat_at").notNull().defaultNow(),

    a2aTokenId: t
      .text("a2a_token_id")
      .references((): AnyPgColumn => a2aToken.id, { onDelete: "set null" }),
    a2aClientName: t.text("a2a_client_name"),
    // why: no FK; the id outlives its endpoint, so those Chats stay out of extraction
    a2aEndpointId: t.text("a2a_endpoint_id"),
    triggerRunId: t
      .text("trigger_run_id")
      .references((): AnyPgColumn => triggerRun.id, { onDelete: "cascade" }),

    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    check(
      "chat_status_allowed",
      sql`${t.status} in ('running', 'succeeded', 'failed', 'cancelled')`,
    ),
    index("idx_chat_workspace_pinned_created").on(
      t.workspaceId,
      t.isPinned.desc().nullsFirst(),
      t.createdAt.desc().nullsFirst(),
    ),
    index("idx_chat_workspace_updated_at").on(t.workspaceId, t.updatedAt),
    index("idx_chat_running")
      .on(t.id)
      .where(sql`${t.status} = 'running'`),
    index("idx_chat_provider_id").on(t.providerId),
    index("idx_chat_a2a_token_id").on(t.a2aTokenId),
    index("idx_chat_trigger_run_id").on(t.triggerRunId),
    check(
      "chat_one_binding",
      sql`${t.a2aEndpointId} is null or ${t.triggerRunId} is null`,
    ),
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

export const chatMessage = pgTable(
  "chat_message",
  (t) => ({
    chatId: t
      .text("chat_id")
      .notNull()
      .references((): AnyPgColumn => chat.id, { onDelete: "cascade" }),
    // why: client-generated, so unique only within its Chat
    id: t.text("id").notNull(),
    parentId: t.text("parent_id"),
    role: t.text("role").$type<"user" | "assistant">().notNull(),
    parts: t.jsonb("parts").$type<PlatypusUIMessage["parts"]>().notNull(),
    metadata: t.jsonb("metadata").$type<ChatMessageMetadata>(),
    deletedAt: t.timestamp("deleted_at"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    primaryKey({ columns: [t.chatId, t.id] }),
    index("idx_chat_message_chat_id_parent_id").on(t.chatId, t.parentId),
    foreignKey({
      columns: [t.chatId, t.parentId],
      foreignColumns: [t.chatId, t.id],
    }),
  ],
);

export const chatSummary = pgTable(
  "chat_summary",
  (t) => ({
    id: t.text("id").primaryKey(),
    chatId: t
      .text("chat_id")
      .notNull()
      .references((): AnyPgColumn => chat.id, { onDelete: "cascade" }),
    anchorId: t.text("anchor_id").notNull(),
    coveredIds: t.jsonb("covered_ids").$type<string[]>().notNull(),
    text: t.text("text").notNull(),
    stats: t.jsonb("stats").$type<TranscriptSummaryStats>(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_chat_summary_chat_id_created_at").on(
      t.chatId,
      t.createdAt.desc().nullsFirst(),
    ),
    index("idx_chat_summary_chat_id_anchor_id").on(t.chatId, t.anchorId),
    foreignKey({
      columns: [t.chatId, t.anchorId],
      foreignColumns: [chatMessage.chatId, chatMessage.id],
    }).onDelete("cascade"),
  ],
);

export const artifact = pgTable(
  "artifact",
  (t) => ({
    id: t.text("id").primaryKey(),
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    sourceChatId: t
      .text("source_chat_id")
      .references(() => chat.id, { onDelete: "set null" }),
    title: t.text("title").notNull(),
    type: t.text("type").$type<ArtifactType>().notNull(),
    language: t.text("language"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_artifact_workspace_id").on(t.workspaceId),
    index("idx_artifact_source_chat_id").on(t.sourceChatId),
    index("idx_artifact_workspace_updated_at").on(
      t.workspaceId,
      t.updatedAt.desc(),
    ),
  ],
);

export const artifactVersion = pgTable(
  "artifact_version",
  (t) => ({
    id: t.text("id").primaryKey(),
    artifactId: t
      .text("artifact_id")
      .notNull()
      .references(() => artifact.id, { onDelete: "cascade" }),
    version: t.integer("version").notNull(),
    content: t.text("content").notNull(),
    author: t.text("author").$type<ArtifactAuthor>().notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [unique("unique_artifact_version").on(t.artifactId, t.version)],
);

export const agent = pgTable(
  "agent",
  (t) => ({
    id: t.text("id").primaryKey(),
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
    instructions: t.text("instructions"),
    modelId: t.text("model_id").notNull(),
    fallbackProviderId: t
      .text("fallback_provider_id")
      .references(() => provider.id, {
        onDelete: "restrict",
      }),
    fallbackModelId: t.text("fallback_model_id"),
    maxSteps: t.integer("max_steps"),
    temperature: t.real("temperature"),
    topP: t.real("top_p"),
    topK: t.real("top_k"),
    seed: t.real("seed"),
    presencePenalty: t.real("presence_penalty"),
    frequencyPenalty: t.real("frequency_penalty"),
    reasoningThinking: t.boolean("reasoning_thinking"),
    reasoningEffort: t.text("reasoning_effort").$type<ReasoningEffort>(),
    thinkingBudget: t.integer("thinking_budget"),
    toolSetIds: t.jsonb("tool_set_ids").$type<string[]>().notNull().default([]),
    skillIds: t.jsonb("skill_ids").$type<string[]>().notNull().default([]),
    subAgentIds: t
      .jsonb("sub_agent_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    inputPlaceholder: t.text("input_placeholder"),
    avatarKey: t.text("avatar_key"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    check(
      "agent_scope_exclusive",
      sql`(${t.organizationId} is null) <> (${t.workspaceId} is null)`,
    ),
    index("idx_agent_workspace_id").on(t.workspaceId),
    index("idx_agent_organization_id").on(t.organizationId),
    index("idx_agent_provider_id").on(t.providerId),
    index("idx_agent_fallback_provider_id").on(t.fallbackProviderId),
    unique("unique_agent_name_org").on(t.organizationId, t.name),
  ],
);

export const mcp = pgTable(
  "mcp",
  (t) => ({
    id: t.text("id").primaryKey(),
    organizationId: t
      .text("organization_id")
      .references(() => organization.id, {
        onDelete: "cascade",
      }),
    workspaceId: t.text("workspace_id").references(() => workspace.id, {
      onDelete: "cascade",
    }),
    name: t.text("name").notNull(),
    slug: t.text("slug").notNull(),
    url: t.text("url"),
    headers: t.jsonb("headers").$type<Record<string, string>>(),
    authType: t.text("auth_type").notNull(),
    bearerToken: t.text("bearer_token"),
    oauthAccessToken: t.text("oauth_access_token"),
    oauthRefreshToken: t.text("oauth_refresh_token"),
    oauthTokenExpiresAt: t.timestamp("oauth_token_expires_at"),
    oauthScope: t.text("oauth_scope"),
    oauthRequestedScope: t.text("oauth_requested_scope"),
    oauthClientId: t.text("oauth_client_id"),
    oauthClientSecret: t.text("oauth_client_secret"),
    oauthClientDynamicallyRegistered: t
      .boolean("oauth_client_dynamically_registered")
      .notNull()
      .default(false),
    oauthAuthorizationServer: t
      .jsonb("oauth_authorization_server")
      .$type<OAuthAuthorizationServerInformation>(),
    lastKnownToolListing: t
      .json("last_known_tool_listing")
      .$type<ListToolsResult>(),
    lastKnownToolListingFetchedAt: t.timestamp(
      "last_known_tool_listing_fetched_at",
    ),
    lastFetchFailedAt: t.timestamp("last_fetch_failed_at"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    check(
      "mcp_scope_exclusive",
      sql`(${t.organizationId} is null) <> (${t.workspaceId} is null)`,
    ),
    index("idx_mcp_workspace_id").on(t.workspaceId),
    index("idx_mcp_organization_id").on(t.organizationId),
    unique("unique_mcp_name_org").on(t.organizationId, t.name),
    unique("unique_mcp_name_workspace").on(t.workspaceId, t.name),
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
    userId: t
      .text("user_id")
      .references(() => user.id, { onDelete: "cascade" }),
    codeVerifier: t.text("code_verifier").notNull(),
    authorizationServer: t
      .jsonb("authorization_server")
      .$type<OAuthAuthorizationServerInformation>(),
    redirectUri: t.text("redirect_uri").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    expiresAt: t.timestamp("expires_at").notNull(),
  }),
  (t) => [
    index("idx_mcp_oauth_state_mcp_id").on(t.mcpId),
    index("idx_mcp_oauth_state_user_id").on(t.userId),
  ],
);

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
      .$type<AttachmentResourceType>()
      .notNull(),
    resourceId: t.text("resource_id").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_attachment_workspace").on(t.workspaceId, t.resourceType),
    index("idx_attachment_resource").on(t.resourceType, t.resourceId),
    unique("unique_attachment").on(t.workspaceId, t.resourceType, t.resourceId),
  ],
);

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
      .$type<AttachmentResourceType>()
      .notNull(),
    resourceId: t.text("resource_id").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_blueprint_item_blueprint").on(t.blueprintId),
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
    role: t.text("role").$type<OrgRole>().notNull().default("member"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    check(
      "organization_member_role_allowed",
      sql`${t.role} in ('admin', 'member')`,
    ),
    index("idx_org_member_org_id").on(t.organizationId),
    index("idx_org_member_user_id").on(t.userId),
    unique("unique_org_member_org_user").on(t.organizationId, t.userId),
  ],
);

export const invitation = pgTable(
  "invitation",
  (t) => ({
    id: t.text("id").primaryKey(),
    email: t.text("email").notNull(),
    organizationId: t
      .text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    invitedBy: t
      .text("invited_by")
      .references(() => user.id, { onDelete: "set null" }),
    status: t.text("status").notNull().default("pending"),
    workspaceName: t.text("workspace_name"),
    token: t.text("token").notNull(),
    expiresAt: t.timestamp("expires_at").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_invitation_email").on(t.email),
    index("idx_invitation_org_id").on(t.organizationId),
    index("idx_invitation_invited_by").on(t.invitedBy),
    uniqueIndex("unique_invitation_org_email")
      .on(t.organizationId, t.email)
      .where(sql`${t.status} = 'pending'`),
    unique("unique_invitation_token").on(t.token),
  ],
);

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
    index("idx_invitation_blueprint_blueprint").on(t.blueprintId),
    unique("unique_invitation_blueprint").on(t.invitationId, t.blueprintId),
  ],
);

export const skill = pgTable(
  "skill",
  (t) => ({
    id: t.text("id").primaryKey(),
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
    frontmatter: t
      .jsonb("frontmatter")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    bundleHash: t.text("bundle_hash"),
    needsSandbox: t.boolean("needs_sandbox").notNull().default(false),
    sourceType: t.text("source_type"),
    source: t.text("source"),
    ref: t.text("ref"),
    skillPath: t.text("skill_path"),
    commitSha: t.text("commit_sha"),
    installedHash: t.text("installed_hash"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    check(
      "skill_scope_exclusive",
      sql`(${t.organizationId} is null) <> (${t.workspaceId} is null)`,
    ),
    index("idx_skill_workspace_id").on(t.workspaceId),
    index("idx_skill_organization_id").on(t.organizationId),
    unique("unique_skill_name_workspace").on(t.workspaceId, t.name),
    unique("unique_skill_name_org").on(t.organizationId, t.name),
  ],
);

export const skillFile = pgTable(
  "skill_file",
  (t) => ({
    id: t.text("id").primaryKey(),
    skillId: t
      .text("skill_id")
      .notNull()
      .references(() => skill.id, { onDelete: "cascade" }),
    path: t.text("path").notNull(),
    size: t.integer("size").notNull(),
    sha256: t.text("sha256").notNull(),
    isText: t.boolean("is_text").notNull(),
    storageKey: t.text("storage_key").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [unique("unique_skill_file_path").on(t.skillId, t.path)],
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
    // why: no HNSW index; dimensions vary per Workspace, and reads are scoped per user
    embedding: unboundVector("embedding"),
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
    type: t.text("type").$type<TriggerType>().notNull(),
    name: t.text("name").notNull(),
    description: t.text("description"),
    instruction: t.text("instruction").notNull(),
    enabled: t.boolean("enabled").notNull().default(true),
    maxRunsToKeep: t.integer("max_runs_to_keep").notNull().default(10),
    search: t.boolean("search").notNull().default(false),
    includeMemories: t.boolean("include_memories").notNull().default(false),
    extractMemories: t.boolean("extract_memories").notNull().default(false),
    config: t
      .jsonb("config")
      .$type<z.infer<typeof triggerSchema>["config"]>()
      .notNull(),
    lastRunAt: t.timestamp("last_run_at"),
    nextRunAt: t.timestamp("next_run_at"),
    firedAt: t.timestamp("fired_at"),
    tokenHash: t.text("token_hash"),
    tokenCreatedAt: t.timestamp("token_created_at"),
    tokenExpiresAt: t.timestamp("token_expires_at"),
    tokenNotice: t.text("token_notice"),
    lastUsedAt: t.timestamp("last_used_at"),
    lastRejectedAt: t.timestamp("last_rejected_at"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    check(
      "trigger_type_allowed",
      sql`${t.type} in ('cron', 'event', 'inbound')`,
    ),
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
    status: t
      .text("status")
      .$type<TriggerRunStatus>()
      .notNull()
      .default("pending"),
    eventType: t.text("event_type").$type<EventTriggerEvent>(),
    eventData: t
      .jsonb("event_data")
      .$type<
        EventTriggerEventPayload["data"] | { inputs: Record<string, string> }
      >(),
    entityId: t.text("entity_id"),
    startedAt: t.timestamp("started_at").notNull().defaultNow(),
    completedAt: t.timestamp("completed_at"),
    errorMessage: t.text("error_message"),
    stats: t.jsonb("stats").$type<TriggerRunStats>(),
    finalText: t.text("final_text"),
    eventsTruncated: t.boolean("events_truncated").notNull().default(false),
    unloadedToolSets: t
      .jsonb("unloaded_tool_sets")
      .$type<UnloadedToolSet[]>()
      .notNull()
      .default([]),
    failedToolCalls: t.integer("failed_tool_calls").notNull().default(0),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    check(
      "trigger_run_status_allowed",
      sql`${t.status} in ('pending', 'running', 'success', 'failed', 'cancelled', 'suppressed')`,
    ),
    check(
      "trigger_run_event_type_allowed",
      sql`${t.eventType} is null or ${t.eventType} in ('notification.created', 'notification.updated', 'notification.read', 'notification.dismissed', 'card.created', 'card.updated', 'card.moved', 'card.deleted')`,
    ),
    index("idx_trigger_run_trigger_id").on(t.triggerId),
    index("idx_trigger_run_started_at").on(t.startedAt),
    index("idx_trigger_run_unfinished")
      .on(t.triggerId)
      .where(sql`${t.status} in ('pending', 'running')`),
    index("idx_trigger_run_trigger_entity_started_at").on(
      t.triggerId,
      t.entityId,
      t.startedAt,
    ),
  ],
);

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
    labels: t.jsonb("labels").$type<KanbanLabel[]>().notNull().default([]),
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
  (t) => [
    index("idx_kanban_column_board_id").on(t.boardId),
    unique("unique_kanban_column_name_board").on(t.boardId, t.name),
  ],
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
      .$type<KanbanCardAssignee[]>()
      .notNull()
      .default([]),
    dueDate: t.timestamp("due_date"),
    priority: t
      .text("priority")
      .$type<KanbanCardPriority>()
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
    seq: t.integer("seq").notNull(),
    type: t.text("type").$type<RunEventType>().notNull(),
    toolName: t.text("tool_name"),
    startedAt: t.bigint("started_at", { mode: "number" }).notNull(),
    durationMs: t.integer("duration_ms"),
    status: t.text("status").$type<RunEventStatus>().notNull(),
    error: t.jsonb("error").$type<RunEventError>(),
    modelSwitch: t.jsonb("model_switch").$type<ModelSwitch>(),
    childrenTruncated: t.boolean("children_truncated").notNull().default(false),
  }),
  (t) => [
    check(
      "trigger_run_event_type_allowed",
      sql`${t.type} in ('tool-call', 'tool-input', 'reasoning', 'text', 'delegate', 'model-switch')`,
    ),
    check(
      "trigger_run_event_status_allowed",
      sql`${t.status} in ('running', 'completed', 'error', 'cancelled')`,
    ),
    index("idx_trigger_run_event_run_id_seq").on(t.runId, t.seq),
    index("idx_trigger_run_event_parent_event_id").on(t.parentEventId),
  ],
);

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
      .references(() => agent.id, { onDelete: "cascade" }),
    title: t.text("title"),
    body: t.text("body").notNull(),
    sourceChatId: t
      .text("source_chat_id")
      .references(() => chat.id, { onDelete: "set null" }),
    sourceTriggerRunId: t
      .text("source_trigger_run_id")
      .references(() => triggerRun.id, { onDelete: "set null" }),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_notification_workspace_id").on(t.workspaceId),
    index("idx_notification_agent_id").on(t.agentId),
    index("idx_notification_created_at").on(t.createdAt),
    index("idx_notification_source_chat_id").on(t.sourceChatId),
    index("idx_notification_source_trigger_run_id").on(t.sourceTriggerRunId),
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

export const workspaceAgentPin = pgTable(
  "workspace_agent_pin",
  (t) => ({
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    agentId: t
      .text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.agentId] }),
    index("idx_workspace_agent_pin_agent_id").on(t.agentId),
  ],
);

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
    name: t.text("name").notNull(),
    description: t.text("description").notNull(),
    enabled: t.boolean("enabled").notNull().default(true),
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
    tokenCreatedAt: t.timestamp("token_created_at").notNull(),
    tokenExpiresAt: t.timestamp("token_expires_at").notNull(),
    tokenNotice: t.text("token_notice"),
    lastUsedAt: t.timestamp("last_used_at"),
    lastRejectedAt: t.timestamp("last_rejected_at"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [index("idx_a2a_token_endpoint_id").on(t.endpointId)],
);

export type A2aTaskEndState = "completed" | "failed" | "canceled";

export const a2aTask = pgTable(
  "a2a_task",
  (t) => ({
    id: t.text("id").primaryKey(),
    chatId: t.text("chat_id").notNull(),
    contextId: t.text("context_id"),
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
    pushCount: t.integer("push_count").notNull().default(0),
    replyId: t.text("reply_id"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    uniqueIndex("idx_a2a_task_chat_id_message_id").on(t.chatId, t.messageId),
    index("idx_a2a_task_endpoint_id").on(t.endpointId),
    index("idx_a2a_task_token_id_status_at_id").on(
      t.tokenId,
      t.statusAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index("idx_a2a_task_token_id_unended")
      .on(t.tokenId)
      .where(sql`${t.state} IS NULL`),
    index("idx_a2a_task_chat_id_reply_id").on(t.chatId, t.replyId),
    foreignKey({
      columns: [t.chatId, t.messageId],
      foreignColumns: [chatMessage.chatId, chatMessage.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "a2a_task_reply_fk",
      columns: [t.chatId, t.replyId],
      foreignColumns: [chatMessage.chatId, chatMessage.id],
    }).onDelete("set null"),
  ],
);

export type A2aPushAuthentication = { scheme: string; credentials?: string };

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
    claimedAt: t.timestamp("claimed_at"),
    notifiedAt: t.timestamp("notified_at"),
    failedAt: t.timestamp("failed_at"),
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
    index("idx_kanban_card_history_card_id_created_at").on(
      t.cardId,
      t.createdAt,
    ),
    index("idx_kanban_card_history_actor_user_id").on(t.actorUserId),
    index("idx_kanban_card_history_actor_agent_id").on(t.actorAgentId),
  ],
);
