import { z } from "zod";

// Organisation

export const organisationSchema = z.object({
  id: z.string(),
  name: z.string(),
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
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Chat = z.infer<typeof chatSchema>;

export const chatSubmitSchema = chatSchema
  .pick({
    id: true,
    workspaceId: true,
    messages: true,
  })
  .extend({
    providerId: z.string(),
    modelId: z.string(),
  });

export const chatUpdateSchema = chatSchema.pick({
  workspaceId: true,
  title: true,
  isStarred: true,
});

export const chatGenerateTitleSchema = z.object({
  providerId: z.string(),
});

export const chatListItemSchema = chatSchema.pick({
  id: true,
  title: true,
  isStarred: true,
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
  tools: z.array(z.string()).optional(),
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
  tools: true,
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
  tools: true,
});

// Tool

export const toolSchema = z.object({
  id: z.string(),
  description: z.string(),
  category: z.string().optional(),
});

export type Tool = z.infer<typeof toolSchema>;

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

// Provider

export const providerSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().min(3).max(32),
  providerType: z.enum(["OpenAI", "OpenRouter"]),
  apiKey: z.string().min(1),
  baseUrl: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  modelIds: z.array(z.string()).min(1),
  taskModelId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Provider = z.infer<typeof providerSchema>;

export const providerCreateSchema = providerSchema.pick({
  workspaceId: true,
  name: true,
  providerType: true,
  apiKey: true,
  baseUrl: true,
  headers: true,
  modelIds: true,
  taskModelId: true,
});

export const providerUpdateSchema = providerSchema.pick({
  name: true,
  providerType: true,
  apiKey: true,
  baseUrl: true,
  headers: true,
  modelIds: true,
  taskModelId: true,
});
