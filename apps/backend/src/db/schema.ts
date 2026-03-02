import { pgTable, index, unique, type AnyPgColumn } from "drizzle-orm/pg-core";

// Import and re-export auth schema
export * from "./auth-schema.ts";
import { user } from "./auth-schema.ts";

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
    modelIds: t.jsonb().$type<string[]>().notNull(),
    taskModelId: t.text("task_model_id").notNull(),
    memoryExtractionModelId: t.text("memory_extraction_model_id").notNull(),
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

    // Schedule association
    scheduleId: t
      .text("schedule_id")
      .references(() => schedule.id, { onDelete: "cascade" }),

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
    index("idx_chat_schedule_id").on(t.scheduleId),
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
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, {
        onDelete: "cascade",
      }),
    name: t.text("name").notNull(),
    url: t.text("url"),
    authType: t.text("auth_type").notNull(),
    bearerToken: t.text("bearer_token"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [index("idx_mcp_workspace_id").on(t.workspaceId)],
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

export const memory = pgTable(
  "memory",
  (t) => ({
    id: t.text("id").primaryKey(),

    // IMPORTANT: All memories are user-owned (userId always set)
    // Scope determines where memory is relevant:
    //   - User-level: workspaceId = NULL (applies across all workspaces for this user)
    //   - Workspace-level: workspaceId set (applies only in this workspace for this user)
    // Since workspaces are single-user owned and only the owner can chat,
    // workspace-level memories always belong to the workspace owner.
    userId: t
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: t
      .text("workspace_id")
      .references(() => workspace.id, { onDelete: "cascade" }),

    // Source tracking
    chatId: t
      .text("chat_id")
      .references(() => chat.id, { onDelete: "set null" }),

    // Entity-based memory structure
    entityType: t.text("entity_type").notNull(), // "preference" | "fact" | "goal" | "constraint" | "style" | "person"
    entityName: t.text("entity_name").notNull(), // e.g., "communication style", "project framework"
    observation: t.text("observation").notNull(), // The actual memory content

    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    // Primary index for scope-based retrieval (most common query pattern)
    index("idx_memory_user_workspace").on(t.userId, t.workspaceId),

    // Source tracking
    index("idx_memory_chat_id").on(t.chatId),
  ],
);

export const schedule = pgTable(
  "schedule",
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
    name: t.text("name").notNull(),
    description: t.text("description"),
    instruction: t.text("instruction").notNull(),
    cronExpression: t.text("cron_expression").notNull(),
    timezone: t.text("timezone").notNull().default("UTC"),
    isOneOff: t.boolean("is_one_off").notNull().default(false),
    enabled: t.boolean("enabled").notNull().default(true),
    maxChatsToKeep: t.integer("max_chats_to_keep").notNull().default(50),
    lastRunAt: t.timestamp("last_run_at"),
    nextRunAt: t.timestamp("next_run_at"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_schedule_workspace_id").on(t.workspaceId),
    index("idx_schedule_next_run_at").on(t.nextRunAt),
  ],
);

export const scheduleRun = pgTable(
  "schedule_run",
  (t) => ({
    id: t.text("id").primaryKey(),
    scheduleId: t
      .text("schedule_id")
      .notNull()
      .references(() => schedule.id, { onDelete: "cascade" }),
    chatId: t
      .text("chat_id")
      .references(() => chat.id, { onDelete: "set null" }),
    status: t.text("status").notNull().default("pending"), // pending | running | success | failed
    startedAt: t.timestamp("started_at").notNull().defaultNow(),
    completedAt: t.timestamp("completed_at"),
    errorMessage: t.text("error_message"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_schedule_run_schedule_id").on(t.scheduleId),
    index("idx_schedule_run_started_at").on(t.startedAt),
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
    index("idx_kanban_card_column_position").on(t.columnId, t.position),
  ],
);
