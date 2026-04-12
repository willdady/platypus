import { z } from "zod";

const kebabCaseRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Organization

export const organizationSchema = z.object({
  id: z.string(),
  name: z.string().min(3).max(30),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Organization = z.infer<typeof organizationSchema>;

export const organizationCreateSchema = organizationSchema.pick({ name: true });

export const organizationUpdateSchema = organizationSchema.pick({ name: true });

// Workspace

export const workspaceSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  ownerId: z.string(),
  name: z.string().min(3).max(30),
  context: z.string().max(1000).nullable().optional(),
  taskModelProviderId: z.string().nullable().optional(),
  memoryExtractionProviderId: z.string().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Workspace = z.infer<typeof workspaceSchema>;

export const workspaceCreateSchema = workspaceSchema.pick({
  name: true,
  organizationId: true,
  context: true,
});

export const workspaceUpdateSchema = workspaceSchema.pick({
  name: true,
  context: true,
  taskModelProviderId: true,
  memoryExtractionProviderId: true,
});

// Chat

export const chatSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string().min(3).max(30),
  messages: z.any().optional(),
  isPinned: z.boolean(),
  tags: z
    .array(z.string().regex(kebabCaseRegex, "Tags must be kebab-case"))
    .max(5, "A chat can have at most 5 tags")
    .optional(),
  agentId: z.string().optional(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  systemPrompt: z.string().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  seed: z.number().optional(),
  presencePenalty: z.number().optional(),
  frequencyPenalty: z.number().optional(),
  triggerId: z.string().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Chat = z.infer<typeof chatSchema>;

export const chatSubmitSchema = chatSchema
  .pick({
    id: true,
    workspaceId: true,
    messages: true,
    systemPrompt: true,
    temperature: true,
    topP: true,
    topK: true,
    seed: true,
    presencePenalty: true,
    frequencyPenalty: true,
  })
  .extend({
    agentId: z.string().optional(),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
    search: z.boolean().optional(),
  })
  .refine(
    (data) => {
      const hasAgent = Boolean(data.agentId);
      const hasProviderModel = Boolean(data.providerId && data.modelId);
      return hasAgent || hasProviderModel;
    },
    {
      message: "Must provide either agentId or (providerId and modelId)",
      path: ["agentId"],
    },
  );

export const chatUpdateSchema = chatSchema.pick({
  workspaceId: true,
  title: true,
  isPinned: true,
  tags: true,
});

export type ChatUpdateData = z.infer<typeof chatUpdateSchema>;

export type ChatSubmitData = z.infer<typeof chatSubmitSchema>;

export const chatGenerateMetadataSchema = z.object({
  providerId: z.string(),
});

export const chatListItemSchema = chatSchema.pick({
  id: true,
  title: true,
  isPinned: true,
  tags: true,
  agentId: true,
  providerId: true,
  modelId: true,
  triggerId: true,
  createdAt: true,
  updatedAt: true,
});

export type ChatListItem = z.infer<typeof chatListItemSchema>;

export const chatListSchema = z.object({
  results: z.array(chatListItemSchema),
});

export type ChatList = z.infer<typeof chatListSchema>;

// Agent

export const agentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  providerId: z.string(),
  name: z.string().min(3).max(30),
  description: z.string().min(1).max(96),
  systemPrompt: z.string().optional(),
  modelId: z.string(),
  maxSteps: z.number().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  seed: z.number().optional(),
  presencePenalty: z.number().optional(),
  frequencyPenalty: z.number().optional(),
  toolSetIds: z.array(z.string()).optional(),
  skillIds: z.array(z.string()).optional(),
  subAgentIds: z.array(z.string()).optional(),
  inputPlaceholder: z.string().max(100).optional(),
  avatarUrl: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Agent = z.infer<typeof agentSchema>;

export const agentCreateSchema = agentSchema.pick({
  workspaceId: true,
  providerId: true,
  name: true,
  description: true,
  systemPrompt: true,
  modelId: true,
  maxSteps: true,
  temperature: true,
  topP: true,
  topK: true,
  seed: true,
  presencePenalty: true,
  frequencyPenalty: true,
  toolSetIds: true,
  skillIds: true,
  subAgentIds: true,
  inputPlaceholder: true,
});

export const agentUpdateSchema = agentSchema.pick({
  providerId: true,
  name: true,
  description: true,
  systemPrompt: true,
  modelId: true,
  maxSteps: true,
  temperature: true,
  topP: true,
  topK: true,
  seed: true,
  presencePenalty: true,
  frequencyPenalty: true,
  toolSetIds: true,
  skillIds: true,
  subAgentIds: true,
  inputPlaceholder: true,
});

// Skill

const skillNameRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const skillSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z
    .string()
    .min(5)
    .max(64)
    .regex(skillNameRegex, "Skill name must be kebab-case"),
  description: z.string().min(24).max(128),
  body: z.string().min(48).max(5000),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Skill = z.infer<typeof skillSchema>;

export const skillCreateSchema = skillSchema
  .pick({
    workspaceId: true,
    name: true,
    description: true,
    body: true,
  })
  .extend({
    agentIds: z.array(z.string()).optional(),
  });

export const skillUpdateSchema = skillSchema
  .pick({
    name: true,
    description: true,
    body: true,
  })
  .extend({
    agentIds: z.array(z.string()).optional(),
  });

// Tool

export const toolSchema = z.object({
  id: z.string(),
  description: z.string(),
  category: z.string().optional(),
});

export type Tool = z.infer<typeof toolSchema>;

// Tool Set

export const toolSetSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  description: z.string().optional(),
  tools: z.array(toolSchema),
});

export type ToolSet = z.infer<typeof toolSetSchema>;

// MCP

const mcpBearerTokenRefine = {
  validator: (data: { authType: string; bearerToken?: string }) => {
    if (data.authType === "Bearer") {
      return data.bearerToken && data.bearerToken.length > 0;
    }
    return true;
  },
  params: {
    message: "Bearer token is required when auth type is Bearer",
    path: ["bearerToken"],
  },
};

const mcpBaseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().min(3).max(30),
  url: z.url(),
  authType: z.enum(["None", "Bearer", "OAuth"]),
  bearerToken: z.string().optional(),
  oauthClientId: z.string().optional(),
  oauthClientSecret: z.string().optional(),
  oauthAuthorized: z.boolean().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const mcpOauthCallbackSchema = z.object({
  code: z.string(),
  state: z.string(),
});

export const mcpSchema = mcpBaseSchema.refine(
  mcpBearerTokenRefine.validator,
  mcpBearerTokenRefine.params,
);

export type MCP = z.infer<typeof mcpSchema>;

export const mcpCreateSchema = mcpBaseSchema
  .pick({
    workspaceId: true,
    name: true,
    url: true,
    authType: true,
    bearerToken: true,
    oauthClientId: true,
    oauthClientSecret: true,
  })
  .refine(mcpBearerTokenRefine.validator, mcpBearerTokenRefine.params);

export const mcpUpdateSchema = mcpBaseSchema
  .pick({
    name: true,
    url: true,
    authType: true,
    bearerToken: true,
    oauthClientId: true,
    oauthClientSecret: true,
  })
  .refine(mcpBearerTokenRefine.validator, mcpBearerTokenRefine.params);

export const mcpTestSchema = mcpBaseSchema
  .pick({
    url: true,
    authType: true,
    bearerToken: true,
  })
  .extend({
    mcpId: z.string().optional(),
  })
  .refine(mcpBearerTokenRefine.validator, mcpBearerTokenRefine.params)
  .refine(
    (data) => {
      if (data.authType === "OAuth") {
        return data.mcpId && data.mcpId.length > 0;
      }
      return true;
    },
    {
      message: "mcpId is required when auth type is OAuth",
      path: ["mcpId"],
    },
  );

// Provider

const providerBaseSchema = z.object({
  id: z.string(),
  organizationId: z.string().optional(),
  workspaceId: z.string().optional(),
  name: z.string().min(3).max(32),
  providerType: z.enum([
    "OpenAI",
    "OpenRouter",
    "Bedrock",
    "Google",
    "Anthropic",
  ]),
  apiKey: z.string().min(1),
  region: z
    .string()
    .regex(/^[a-z]{2}-[a-z]+-\d+$/, "Invalid AWS region format")
    .optional(),
  baseUrl: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
  organization: z.string().optional(),
  project: z.string().optional(),
  modelIds: z.array(z.string()).min(1),
  taskModelId: z.string(),
  memoryExtractionModelId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const providerSchema = providerBaseSchema
  .refine(
    (data) => {
      if (data.providerType === "Bedrock") {
        return data.region && data.region.length > 0;
      }
      return true;
    },
    {
      message: "Region is required for Bedrock providers",
      path: ["region"],
    },
  )
  .refine(
    (data) => {
      const hasOrg = Boolean(data.organizationId);
      const hasWorkspace = Boolean(data.workspaceId);
      return (hasOrg || hasWorkspace) && !(hasOrg && hasWorkspace);
    },
    {
      message:
        "Provider must have either organizationId or workspaceId, but not both",
      path: ["organizationId"],
    },
  );

export type Provider = z.infer<typeof providerSchema>;

export const providerCreateSchema = providerBaseSchema.pick({
  organizationId: true,
  workspaceId: true,
  name: true,
  providerType: true,
  apiKey: true,
  region: true,
  baseUrl: true,
  headers: true,
  extraBody: true,
  organization: true,
  project: true,
  modelIds: true,
  taskModelId: true,
  memoryExtractionModelId: true,
});

// Invitation

export const invitationStatusSchema = z.enum([
  "pending",
  "accepted",
  "declined",
  "expired",
]);

export type InvitationStatus = z.infer<typeof invitationStatusSchema>;

export const invitationSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  organizationId: z.string(),
  invitedBy: z.string(),
  status: invitationStatusSchema,
  expiresAt: z.date(),
  createdAt: z.date(),
});

export type Invitation = z.infer<typeof invitationSchema>;

export const invitationCreateSchema = invitationSchema.pick({
  email: true,
});

export const invitationListItemSchema = invitationSchema.extend({
  organizationName: z.string().optional(),
  invitedByName: z.string().optional(),
});

export type InvitationListItem = z.infer<typeof invitationListItemSchema>;

export const providerUpdateSchema = providerBaseSchema.pick({
  name: true,
  providerType: true,
  apiKey: true,
  region: true,
  baseUrl: true,
  headers: true,
  extraBody: true,
  organization: true,
  project: true,
  modelIds: true,
  taskModelId: true,
  memoryExtractionModelId: true,
});

// Organization Member

export const organizationMemberSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  role: z.enum(["admin", "member"]),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OrganizationMember = z.infer<typeof organizationMemberSchema>;

export const organizationMemberUpdateSchema = organizationMemberSchema.pick({
  role: true,
});

export const organizationMemberWithUserSchema = organizationMemberSchema.extend(
  {
    user: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      image: z.string().nullable().optional(),
    }),
  },
);

export type OrganizationMemberWithUser = z.infer<
  typeof organizationMemberWithUserSchema
>;

// Combined Org Member for List

export const orgMemberListItemSchema = organizationMemberWithUserSchema.extend({
  isSuperAdmin: z.boolean(),
});

export type OrgMemberListItem = z.infer<typeof orgMemberListItemSchema>;

export const orgMemberListSchema = z.object({
  results: z.array(orgMemberListItemSchema),
});

export type OrgMemberList = z.infer<typeof orgMemberListSchema>;

// Context

export const contextSchema = z.object({
  id: z.string(),
  userId: z.string(),
  workspaceId: z.string().nullable().optional(),
  content: z.string().min(0).max(1000),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Context = z.infer<typeof contextSchema>;

export const contextCreateSchema = contextSchema.pick({
  workspaceId: true,
  content: true,
});

export const contextUpdateSchema = contextSchema.pick({
  content: true,
});

// Memory

export const memoryEntityTypeSchema = z.enum([
  "preference",
  "fact",
  "goal",
  "constraint",
  "style",
  "person",
]);

export type MemoryEntityType = z.infer<typeof memoryEntityTypeSchema>;

export const memoryScopeSchema = z.enum(["user", "workspace"]);

export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const memorySchema = z.object({
  id: z.string(),
  userId: z.string(),
  workspaceId: z.string().nullable().optional(),
  chatId: z.string().nullable().optional(),
  entityType: memoryEntityTypeSchema,
  entityName: z.string(),
  observation: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Memory = z.infer<typeof memorySchema>;

export const memoryCreateSchema = z.object({
  userId: z.string(),
  workspaceId: z.string().nullable().optional(),
  chatId: z.string().optional(),
  entityType: memoryEntityTypeSchema,
  entityName: z.string(),
  observation: z.string(),
});

export type MemoryCreateData = z.infer<typeof memoryCreateSchema>;

export const memoryUpdateSchema = z.object({
  entityType: memoryEntityTypeSchema.optional(),
  entityName: z.string().optional(),
  observation: z.string().optional(),
});

export type MemoryUpdateData = z.infer<typeof memoryUpdateSchema>;

// Memory Extraction (for LLM structured output)

export const memoryExtractionNewMemorySchema = z.object({
  entityType: memoryEntityTypeSchema,
  entityName: z.string(),
  observation: z.string(),
  scope: memoryScopeSchema,
});

export type MemoryExtractionNewMemory = z.infer<
  typeof memoryExtractionNewMemorySchema
>;

export const memoryExtractionUpdateSchema = z.object({
  id: z.string(),
  observation: z.string(),
});

export type MemoryExtractionUpdate = z.infer<
  typeof memoryExtractionUpdateSchema
>;

export const memoryExtractionOutputSchema = z.object({
  new: z.array(memoryExtractionNewMemorySchema),
  updates: z.array(memoryExtractionUpdateSchema),
  deletes: z.array(z.string()), // Memory IDs to delete
});

export type MemoryExtractionOutput = z.infer<
  typeof memoryExtractionOutputSchema
>;

// Webhook Event (defined here so trigger schemas can reference it)

export const webhookEventSchema = z.enum([
  "notification.created",
  "notification.updated",
  "notification.read",
  "notification.dismissed",
  "card.created",
  "card.updated",
  "card.deleted",
]);

export type WebhookEvent = z.infer<typeof webhookEventSchema>;

// Trigger

export const triggerTypeSchema = z.enum(["cron", "event"]);

export type TriggerType = z.infer<typeof triggerTypeSchema>;

export const cronTriggerConfigSchema = z.object({
  cronExpression: z.string().min(1),
  timezone: z.string().default("UTC"),
  isOneOff: z.boolean().default(false),
});

export type CronTriggerConfig = z.infer<typeof cronTriggerConfigSchema>;

export const eventTriggerFiltersSchema = z.object({
  boardId: z.string().optional(),
});

export type EventTriggerFilters = z.infer<typeof eventTriggerFiltersSchema>;

export const eventTriggerConfigSchema = z.object({
  events: z.array(webhookEventSchema).min(1),
  filters: eventTriggerFiltersSchema.optional(),
});

export type EventTriggerConfig = z.infer<typeof eventTriggerConfigSchema>;

export const triggerSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  type: triggerTypeSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  instruction: z.string().min(1).max(10000),
  enabled: z.boolean().default(true),
  maxChatsToKeep: z.number().int().min(1).max(1000).default(50),
  search: z.boolean().default(false),
  config: z.union([cronTriggerConfigSchema, eventTriggerConfigSchema]),
  lastRunAt: z.date().nullable().optional(),
  nextRunAt: z.date().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Trigger = z.infer<typeof triggerSchema>;

export const triggerCreateSchema = triggerSchema.pick({
  workspaceId: true,
  agentId: true,
  type: true,
  name: true,
  description: true,
  instruction: true,
  enabled: true,
  maxChatsToKeep: true,
  search: true,
  config: true,
});

export const triggerUpdateSchema = triggerSchema
  .pick({
    name: true,
    description: true,
    instruction: true,
    enabled: true,
    maxChatsToKeep: true,
    agentId: true,
    search: true,
    type: true,
    config: true,
  })
  .partial();

// Trigger Run

export const triggerRunStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "failed",
]);

export type TriggerRunStatus = z.infer<typeof triggerRunStatusSchema>;

export const triggerRunSchema = z.object({
  id: z.string(),
  triggerId: z.string(),
  chatId: z.string().nullable().optional(),
  status: triggerRunStatusSchema,
  eventType: z.string().nullable().optional(),
  eventData: z.any().nullable().optional(),
  startedAt: z.date(),
  completedAt: z.date().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  createdAt: z.date(),
});

export type TriggerRun = z.infer<typeof triggerRunSchema>;

export const triggerRunListSchema = z.object({
  results: z.array(triggerRunSchema),
});

export type TriggerRunList = z.infer<typeof triggerRunListSchema>;

// Notification

export const notificationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  title: z.string().nullable().optional(),
  body: z.string().min(1).max(2000),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Notification = z.infer<typeof notificationSchema>;

export const notificationCreateSchema = notificationSchema.pick({
  title: true,
  body: true,
});

export const notificationUpdateSchema = notificationSchema
  .pick({
    title: true,
    body: true,
  })
  .partial();

export const notificationListItemSchema = notificationSchema.extend({
  agentName: z.string(),
  agentAvatarUrl: z.string().optional(),
  isRead: z.boolean(),
});

export type NotificationListItem = z.infer<typeof notificationListItemSchema>;

// Kanban Label Colors

export const KANBAN_LABEL_COLORS = [
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Green", value: "#22c55e" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Indigo", value: "#6366f1" },
  { name: "Purple", value: "#a855f7" },
  { name: "Pink", value: "#ec4899" },
  { name: "Gray", value: "#6b7280" },
] as const;

// Kanban Label

export const kanbanLabelSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(50),
  color: z.enum(
    KANBAN_LABEL_COLORS.map((c) => c.value) as [string, ...string[]],
  ),
});

export type KanbanLabel = z.infer<typeof kanbanLabelSchema>;

// Kanban Board

export const kanbanBoardSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  labels: z.array(kanbanLabelSchema).default([]),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type KanbanBoard = z.infer<typeof kanbanBoardSchema>;

export const kanbanBoardCreateSchema = kanbanBoardSchema.pick({
  name: true,
  description: true,
  labels: true,
});

export const kanbanBoardUpdateSchema = kanbanBoardSchema.pick({
  name: true,
  description: true,
  labels: true,
});

// Kanban Column

export const kanbanColumnSchema = z.object({
  id: z.string(),
  boardId: z.string(),
  name: z.string().min(1).max(100),
  position: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type KanbanColumn = z.infer<typeof kanbanColumnSchema>;

export const kanbanColumnCreateSchema = kanbanColumnSchema.pick({
  name: true,
});

export const kanbanColumnUpdateSchema = kanbanColumnSchema.pick({
  name: true,
});

export const kanbanColumnReorderSchema = z.object({
  columnIds: z.array(z.string()).min(1),
});

// Kanban Card Priority

export const kanbanCardPrioritySchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "urgent",
]);

export type KanbanCardPriority = z.infer<typeof kanbanCardPrioritySchema>;

export const KANBAN_CARD_PRIORITIES = [
  { value: "none" as const, label: "None", color: null },
  { value: "low" as const, label: "Low", color: "#3b82f6" },
  { value: "medium" as const, label: "Medium", color: "#f59e0b" },
  { value: "high" as const, label: "High", color: "#f97316" },
  { value: "urgent" as const, label: "Urgent", color: "#ef4444" },
] as const;

// Kanban Card Assignee

export const kanbanCardAssigneeSchema = z.object({
  type: z.enum(["user", "agent"]),
  id: z.string(),
});

export type KanbanCardAssignee = z.infer<typeof kanbanCardAssigneeSchema>;

export const kanbanResolvedAssigneeSchema = z.object({
  type: z.enum(["user", "agent"]),
  id: z.string(),
  name: z.string(),
  image: z.string().nullable().optional(),
});

export type KanbanResolvedAssignee = z.infer<
  typeof kanbanResolvedAssigneeSchema
>;

// Kanban Card

export const kanbanCardSchema = z.object({
  id: z.string(),
  columnId: z.string(),
  title: z.string().min(1).max(200),
  body: z.string().nullable().optional(),
  labelIds: z.array(z.string()).default([]),
  assignees: z.array(kanbanCardAssigneeSchema).max(1).default([]),
  dueDate: z.string().nullable().optional(),
  priority: kanbanCardPrioritySchema.default("none"),
  position: z.number(),
  createdByUserId: z.string().nullable().optional(),
  createdByAgentId: z.string().nullable().optional(),
  lastEditedByUserId: z.string().nullable().optional(),
  lastEditedByAgentId: z.string().nullable().optional(),
  createdByName: z.string().nullable().optional(),
  lastEditedByName: z.string().nullable().optional(),
  resolvedAssignees: z.array(kanbanResolvedAssigneeSchema).optional(),
  commentCount: z.number().int().default(0),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type KanbanCard = z.infer<typeof kanbanCardSchema>;

export const kanbanCardCreateSchema = kanbanCardSchema.pick({
  title: true,
  body: true,
  labelIds: true,
  assignees: true,
  dueDate: true,
  priority: true,
});

export const kanbanCardUpdateSchema = kanbanCardSchema
  .pick({
    title: true,
    body: true,
    labelIds: true,
    assignees: true,
    dueDate: true,
    priority: true,
  })
  .partial();

export const kanbanCardMoveSchema = z.object({
  columnId: z.string(),
  afterCardId: z.string().nullable(),
});

// Kanban Card Comment

export const kanbanCardCommentSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  body: z.string().min(1),
  createdByUserId: z.string().nullable().optional(),
  createdByAgentId: z.string().nullable().optional(),
  createdByName: z.string().nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const kanbanCardCommentCreateSchema = kanbanCardCommentSchema.pick({
  body: true,
});

export const kanbanCardCommentUpdateSchema = kanbanCardCommentSchema
  .pick({ body: true })
  .partial();

export type KanbanCardComment = z.infer<typeof kanbanCardCommentSchema>;

// Kanban Board State (nested response)

export const kanbanBoardStateSchema = z.object({
  board: kanbanBoardSchema,
  columns: z.array(
    kanbanColumnSchema.extend({
      cards: z.array(kanbanCardSchema),
    }),
  ),
});

export type KanbanBoardState = z.infer<typeof kanbanBoardStateSchema>;

// Webhook

export const webhookSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().min(1).max(100),
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith("https://"), {
      message: "Webhook URL must use HTTPS",
    }),
  signingSecret: z.string(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  enabled: z.boolean(),
  events: z.array(webhookEventSchema).min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Webhook = z.infer<typeof webhookSchema>;

export const webhookCreateSchema = z.object({
  name: z.string().min(1).max(100),
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith("https://"), {
      message: "Webhook URL must use HTTPS",
    }),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  enabled: z.boolean().optional(),
  events: z.array(webhookEventSchema).min(1).optional(),
});

export const webhookUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith("https://"), {
      message: "Webhook URL must use HTTPS",
    })
    .optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  enabled: z.boolean().optional(),
  events: z.array(webhookEventSchema).min(1).optional(),
});
