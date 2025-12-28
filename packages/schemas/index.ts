import { z } from "zod";

const kebabCaseRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Organisation

export const organisationSchema = z.object({
  id: z.string(),
  name: z.string().min(3).max(30),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Organisation = z.infer<typeof organisationSchema>;

export const organisationCreateSchema = organisationSchema.pick({ name: true });

export const organisationUpdateSchema = organisationSchema.pick({ name: true });

// Workspace

export const workspaceSchema = z.object({
  id: z.string(),
  organisationId: z.string(),
  name: z.string().min(3).max(30),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Workspace = z.infer<typeof workspaceSchema>;

export const workspaceCreateSchema = workspaceSchema.pick({
  name: true,
  organisationId: true,
});

export const workspaceUpdateSchema = workspaceSchema.pick({ name: true });

// Chat

export const chatSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string().min(3).max(30),
  messages: z.any().optional(),
  isStarred: z.boolean(),
  tags: z
    .array(z.string().regex(kebabCaseRegex, "Tags must be kebab-case"))
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
  isStarred: true,
  tags: true,
});

export const chatGenerateMetadataSchema = z.object({
  providerId: z.string(),
});

export const chatListItemSchema = chatSchema.pick({
  id: true,
  title: true,
  isStarred: true,
  tags: true,
  agentId: true,
  providerId: true,
  modelId: true,
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
  description: z.string().optional(),
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

export const mcpSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    name: z.string().min(3).max(30),
    url: z.url(),
    authType: z.enum(["None", "Bearer"]),
    bearerToken: z.string().optional(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .refine(mcpBearerTokenRefine.validator, mcpBearerTokenRefine.params);

export type MCP = z.infer<typeof mcpSchema>;

export const mcpCreateSchema = mcpSchema
  .pick({
    workspaceId: true,
    name: true,
    url: true,
    authType: true,
    bearerToken: true,
  })
  .refine(mcpBearerTokenRefine.validator, mcpBearerTokenRefine.params);

export const mcpUpdateSchema = mcpSchema
  .pick({
    name: true,
    url: true,
    authType: true,
    bearerToken: true,
  })
  .refine(mcpBearerTokenRefine.validator, mcpBearerTokenRefine.params);

export const mcpTestSchema = mcpSchema
  .pick({
    url: true,
    authType: true,
    bearerToken: true,
  })
  .refine(mcpBearerTokenRefine.validator, mcpBearerTokenRefine.params);

// Provider

export const providerSchema = z
  .object({
    id: z.string(),
    organisationId: z.string().optional(),
    workspaceId: z.string().optional(),
    name: z.string().min(3).max(32),
    providerType: z.enum(["OpenAI", "OpenRouter", "Bedrock", "Google"]),
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
    createdAt: z.date(),
    updatedAt: z.date(),
  })
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
      const hasOrg = Boolean(data.organisationId);
      const hasWorkspace = Boolean(data.workspaceId);
      return (hasOrg || hasWorkspace) && !(hasOrg && hasWorkspace);
    },
    {
      message:
        "Provider must have either organisationId or workspaceId, but not both",
      path: ["organisationId"],
    },
  );

export type Provider = z.infer<typeof providerSchema>;

export const providerCreateSchema = providerSchema.pick({
  organisationId: true,
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
  organisationId: z.string(),
  workspaceId: z.string(),
  role: z.enum(["admin", "editor", "viewer"]),
  invitedBy: z.string(),
  status: invitationStatusSchema,
  expiresAt: z.date(),
  createdAt: z.date(),
});

export type Invitation = z.infer<typeof invitationSchema>;

export const invitationCreateSchema = invitationSchema.pick({
  email: true,
  workspaceId: true,
  role: true,
});

export const invitationListItemSchema = invitationSchema.extend({
  organisationName: z.string().optional(),
  workspaceName: z.string().optional(),
  invitedByName: z.string().optional(),
});

export type InvitationListItem = z.infer<typeof invitationListItemSchema>;

export const providerUpdateSchema = providerSchema.pick({
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
});

// Organisation Member

export const organisationMemberSchema = z.object({
  id: z.string(),
  organisationId: z.string(),
  userId: z.string(),
  role: z.enum(["admin", "member"]),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OrganisationMember = z.infer<typeof organisationMemberSchema>;

export const organisationMemberUpdateSchema = organisationMemberSchema.pick({
  role: true,
});

export const organisationMemberWithUserSchema = organisationMemberSchema.extend(
  {
    user: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      image: z.string().nullable().optional(),
    }),
  },
);

export type OrganisationMemberWithUser = z.infer<
  typeof organisationMemberWithUserSchema
>;

// Workspace Member

export const workspaceMemberSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  orgMemberId: z.string(),
  role: z.enum(["admin", "editor", "viewer"]),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

export const workspaceMemberCreateSchema = workspaceMemberSchema.pick({
  workspaceId: true,
  role: true,
});

export const workspaceMemberUpdateSchema = workspaceMemberSchema.pick({
  role: true,
});

// Combined Org Member for List

export const orgMemberListItemSchema = organisationMemberWithUserSchema.extend({
  workspaces: z.array(
    z.object({
      workspaceMemberId: z.string(),
      workspaceId: z.string(),
      workspaceName: z.string(),
      role: z.enum(["admin", "editor", "viewer"]),
    }),
  ),
  isSuperAdmin: z.boolean(),
});

export type OrgMemberListItem = z.infer<typeof orgMemberListItemSchema>;

export const orgMemberListSchema = z.object({
  results: z.array(orgMemberListItemSchema),
});

export type OrgMemberList = z.infer<typeof orgMemberListSchema>;
