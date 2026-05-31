import {
  pgTable,
  index,
  unique,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";

// Import and re-export auth schema
export * from "./auth-schema.ts";
import { user } from "./auth-schema.ts";

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
      return JSON.parse(value);
    }
    return value as number[];
  },
});

export const organization = pgTable("organization", (t) => ({
  id: t.text("id").primaryKey(),
  name: t.text("name").notNull(),
  createdAt: t.timestamp("created_at").notNull().defaultNow(),
  updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
}));

// Provider defined before workspace to avoid circular reference with task_model_provider_id
// The workspace_id FK will be added after workspace is defined
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
    modelIds: t.jsonb().$type<string[]>().notNull(),
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

    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_workspace_organization_id").on(t.organizationId),
    index("idx_workspace_owner_id").on(t.ownerId),
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
    messages: t.jsonb("messages"),
    // Run lifecycle status. Existing rows backfill to "succeeded" — every
    // chat row pre-status was the result of a completed run.
    status: t.text("status").notNull().default("succeeded"),
    isPinned: t.boolean("is_pinned").notNull().default(false),
    tags: t.jsonb("tags").$type<string[]>().default([]),
    agentId: t.text("agent_id"),
    providerId: t.text("provider_id"),
    modelId: t.text("model_id"),
    systemPrompt: t.text("system_prompt"),
    temperature: t.real("temperature"),
    topP: t.real("top_p"),
    topK: t.real("top_k"),
    seed: t.real("seed"),
    presencePenalty: t.real("presence_penalty"),
    frequencyPenalty: t.real("frequency_penalty"),

    // Memory processing tracking
    lastMemoryProcessedAt: t.timestamp("last_memory_processed_at"),
    memoryExtractionStatus: t
      .text("memory_extraction_status")
      .default("pending"), // "pending" | "processing" | "completed" | "failed"

    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_chat_workspace_id").on(t.workspaceId),
    index("idx_chat_tags").using("gin", t.tags),
    index("idx_chat_memory_processing").on(
      t.memoryExtractionStatus,
      t.lastMemoryProcessedAt,
      t.updatedAt,
    ),
  ],
);

export const agent = pgTable(
  "agent",
  (t) => ({
    id: t.text("id").primaryKey(),
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, {
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
    systemPrompt: t.text("system_prompt"),
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
    index("idx_agent_provider_id").on(t.providerId),
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
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_mcp_workspace_id").on(t.workspaceId),
    index("idx_mcp_organization_id").on(t.organizationId),
    unique("unique_mcp_name_org").on(t.organizationId, t.name),
    unique("unique_mcp_name_workspace").on(t.workspaceId, t.name),
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
    invitedBy: t
      .text("invited_by")
      .notNull()
      .references(() => user.id),
    status: t.text("status").notNull().default("pending"), // pending | accepted | declined | expired
    // Optional name for the Workspace provisioned on accept (ADR-0008). Null
    // defaults to "<member name>'s Workspace" at accept time.
    workspaceName: t.text("workspace_name"),
    expiresAt: t.timestamp("expires_at").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_invitation_email").on(t.email),
    index("idx_invitation_org_id").on(t.organizationId),
    unique("unique_invitation_org_email").on(t.organizationId, t.email),
  ],
);

export const skill = pgTable(
  "skill",
  (t) => ({
    id: t.text("id").primaryKey(),
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, {
        onDelete: "cascade",
      }),
    name: t.text("name").notNull(),
    description: t.text("description").notNull(),
    body: t.text("body").notNull(),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_skill_workspace_id").on(t.workspaceId),
    unique("unique_skill_name_workspace").on(t.workspaceId, t.name),
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
    unique("unique_context_user_workspace").on(t.userId, t.workspaceId),
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
    type: t.text("type").notNull(), // "cron" | "event"
    name: t.text("name").notNull(),
    description: t.text("description"),
    instruction: t.text("instruction").notNull(),
    enabled: t.boolean("enabled").notNull().default(true),
    maxRunsToKeep: t.integer("max_runs_to_keep").notNull().default(10),
    search: t.boolean("search").notNull().default(false),
    config: t.jsonb("config").notNull(),
    lastRunAt: t.timestamp("last_run_at"),
    nextRunAt: t.timestamp("next_run_at"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_trigger_workspace_id").on(t.workspaceId),
    index("idx_trigger_next_run_at").on(t.nextRunAt),
    index("idx_trigger_type").on(t.type),
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
    status: t.text("status").notNull().default("pending"), // pending | running | success | failed
    eventType: t.text("event_type"),
    eventData: t.jsonb("event_data"),
    startedAt: t.timestamp("started_at").notNull().defaultNow(),
    completedAt: t.timestamp("completed_at"),
    errorMessage: t.text("error_message"),
    stats: t.jsonb("stats"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_trigger_run_trigger_id").on(t.triggerId),
    index("idx_trigger_run_started_at").on(t.startedAt),
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
  (t) => [index("idx_kanban_card_comment_card_id").on(t.cardId)],
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
