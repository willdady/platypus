import { pgTable, primaryKey, jsonb } from "drizzle-orm/pg-core";

export const organisation = pgTable("organisation", (t) => ({
  id: t.text("id").primaryKey(),
  name: t.text("name").notNull(),
  createdAt: t.timestamp("created_at").notNull().defaultNow(),
  updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
}));

export const workspace = pgTable("workspace", (t) => ({
  id: t.text("id").primaryKey(),
  organisationId: t.text("organisation_id").references(() => organisation.id, {
    onDelete: "cascade",
  }),
  name: t.text("name").notNull(),
  createdAt: t.timestamp("created_at").notNull().defaultNow(),
  updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
}));

export const chat = pgTable("chat", (t) => ({
  id: t.text("id").primaryKey(),
  workspaceId: t.text("workspace_id").references(() => workspace.id, {
    onDelete: "cascade",
  }),
  title: t.text("title").notNull(),
  messages: t.jsonb("messages"),
  createdAt: t.timestamp("created_at").notNull().defaultNow(),
  updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
}));

export const agent = pgTable("agent", (t) => ({
  id: t.text("id").primaryKey(),
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
  systemPrompt: t.text("system_prompt"),
  modelId: t.text("model_id").notNull(),
  maxSteps: t.integer("max_steps"),
  temperature: t.real("temperature"),
  topP: t.real("top_p"),
  topK: t.real("top_k"),
  seed: t.real("seed"),
  presencePenalty: t.real("presence_penalty"),
  frequencyPenalty: t.real("frequency_penalty"),
  tools: t.jsonb().$type<string[]>().default([]), // Array of tool ids
  createdAt: t.timestamp("created_at").notNull().defaultNow(),
  updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
}));

export const mcp = pgTable("mcp", (t) => ({
  id: t.text("id").primaryKey(),
  workspaceId: t.text("workspace_id").references(() => workspace.id, {
    onDelete: "cascade",
  }),
  name: t.text("name").notNull(),
  url: t.text("url"),
  authType: t.text("auth_type").notNull(),
  bearerToken: t.text("bearer_token"),
  createdAt: t.timestamp("created_at").notNull().defaultNow(),
  updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
}));

export const provider = pgTable("provider", (t) => ({
  id: t.text("id").primaryKey(),
  workspaceId: t.text("workspace_id").references(() => workspace.id, {
    onDelete: "cascade",
  }),
  name: t.text("name").notNull(),
  providerType: t.text("provider_type").notNull(),
  apiKey: t.text("api_key").notNull(),
  baseUrl: t.text("base_url"),
  headers: t.jsonb().$type<Record<string, string>>(),
  modelIds: t.jsonb().$type<string[]>().notNull(),
  createdAt: t.timestamp("created_at").notNull().defaultNow(),
  updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
}));
