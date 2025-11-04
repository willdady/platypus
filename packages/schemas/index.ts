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
  maxSteps: z.number().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Agent = z.infer<typeof agentSchema>;

export const agentCreateSchema = agentSchema.pick({
  workspaceId: true,
  name: true,
  systemPrompt: true,
  maxSteps: true,
});

export const agentUpdateSchema = agentSchema.pick({
  name: true,
  systemPrompt: true,
  maxSteps: true,
});

// Tool

export const toolSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Tool = z.infer<typeof toolSchema>;

export const toolCreateSchema = toolSchema.pick({
  name: true,
  description: true,
});

export const toolUpdateSchema = toolSchema.pick({
  name: true,
  description: true,
});

// Agent / Tool

export const agentToolSchema = z.object({
  agentId: z.string(),
  toolId: z.string(),
});

// MCP

export const mcpSchema = z.object({
  id: z.string(),
  url: z.string().optional(),
  token: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type MCP = z.infer<typeof mcpSchema>;