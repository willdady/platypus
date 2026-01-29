import { pgTable, index, unique } from "drizzle-orm/pg-core";

// Import and re-export auth schema
export * from "./auth-schema.ts";
import { user } from "./auth-schema.ts";

export const organization = pgTable("organization", (t) => ({
  id: t.text("id").primaryKey(),
  name: t.text("name").notNull(),
  createdAt: t.timestamp("created_at").notNull().defaultNow(),
  updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
}));

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
    name: t.text("name").notNull(),
    context: t.text("context"),
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [index("idx_workspace_organization_id").on(t.organizationId)],
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
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [index("idx_chat_workspace_id").on(t.workspaceId)],
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

export const provider = pgTable(
  "provider",
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

// Workspace membership - links users to specific workspaces with granular roles
export const workspaceMember = pgTable(
  "workspace_member",
  (t) => ({
    id: t.text("id").primaryKey(),
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: t
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    orgMemberId: t
      .text("org_member_id")
      .notNull()
      .references(() => organizationMember.id, { onDelete: "cascade" }),
    role: t.text("role").notNull().default("viewer"), // admin | editor | viewer
    createdAt: t.timestamp("created_at").notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
  }),
  (t) => [
    index("idx_ws_member_workspace_id").on(t.workspaceId),
    index("idx_ws_member_user_id").on(t.userId),
  ],
);

// Invitations for both org and workspace levels
export const invitation = pgTable(
  "invitation",
  (t) => ({
    id: t.text("id").primaryKey(),
    email: t.text("email").notNull(),
    organizationId: t
      .text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: t
      .text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    role: t.text("role").notNull(),
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
    index("idx_invitation_workspace_id").on(t.workspaceId),
    unique("unique_invitation_workspace_email").on(t.workspaceId, t.email),
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
