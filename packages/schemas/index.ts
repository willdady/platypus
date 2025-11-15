import { z } from "zod";

// Organisation

export const organisationSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type organisation = z.infer<typeof organisationSchema>;

export const organisationCreateSchema = organisationSchema.pick({ name: true });

export const organisationUpdateSchema = organisationSchema.pick({ name: true });

// Workspace

export const workspaceSchema = z.object({
  id: z.string(),
  organisationId: z.string(),
  name: z.string(),
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
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Chat = z.infer<typeof chatSchema>;

// Agent

export const agentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  systemPrompt: z.string().optional(),
  modelId: z.string(),
  maxSteps: z.number().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  seed: z.number().optional(),
  tools: z.array(z.string()).optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Agent = z.infer<typeof agentSchema>;

export const agentCreateSchema = agentSchema.pick({
  workspaceId: true,
  name: true,
  systemPrompt: true,
  modelId: true,
  maxSteps: true,
  temperature: true,
  topP: true,
  topK: true,
  seed: true,
  tools: true,
});

export const agentUpdateSchema = agentSchema.pick({
  name: true,
  systemPrompt: true,
  modelId: true,
  maxSteps: true,
  temperature: true,
  topP: true,
  topK: true,
  seed: true,
  tools: true,
});

// Tool

export const toolSchema = z.object({
  id: z.string(),
  description: z.string(),
});

export type Tool = z.infer<typeof toolSchema>;

export const toolCreateSchema = toolSchema.pick({
  description: true,
});

export const toolUpdateSchema = toolSchema.pick({
  description: true,
});

// MCP

export const mcpSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  url: z.string().optional(),
  authType: z.enum(["None", "Bearer"]),
  bearerToken: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type MCP = z.infer<typeof mcpSchema>;

export const mcpCreateSchema = mcpSchema.pick({
  workspaceId: true,
  name: true,
  url: true,
  authType: true,
  bearerToken: true,
});

export const mcpUpdateSchema = mcpSchema.pick({
  name: true,
  url: true,
  authType: true,
  bearerToken: true,
});

// Model

export const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export type Model = z.infer<typeof modelSchema>;

// Provider

export const providerSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  providerType: z.enum(["OpenAI"]),
  apiKey: z.string(),
  baseUrl: z.string().optional(),
  authType: z.enum(["None", "Bearer"]),
  bearerToken: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  modelIds: z.array(z.string()),
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
  authType: true,
  bearerToken: true,
  headers: true,
  modelIds: true,
});

export const providerUpdateSchema = providerSchema.pick({
  name: true,
  providerType: true,
  apiKey: true,
  baseUrl: true,
  authType: true,
  bearerToken: true,
  headers: true,
  modelIds: true,
});
