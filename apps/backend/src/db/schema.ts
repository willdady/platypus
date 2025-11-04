import { pgTable, primaryKey } from "drizzle-orm/pg-core";

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
  createdAt: t.timestamp("created_at").notNull().defaultNow(),
  updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
}));

export const agent = pgTable("agent", (t) => ({
  id: t.text("id").primaryKey(),
  workspaceId: t.text("workspace_id").references(() => workspace.id, {
    onDelete: "cascade",
  }),
  name: t.text("name").notNull(),
  systemPrompt: t.text("system_prompt"),
  maxSteps: t.integer("max_steps"),
  createdAt: t.timestamp("created_at").notNull().defaultNow(),
  updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
}));

export const agentTool = pgTable(
  "agent_tool",
  (t) => ({
    agentId: t
      .text("agent_id")
      .notNull()
      .references(() => agent.id, {
        onDelete: "cascade",
      }),
    toolId: t.text("tool_id").notNull(),
  }),
  (t) => [primaryKey({ columns: [t.agentId, t.toolId] })],
);

export const mcp = pgTable("mcp", (t) => ({
  id: t.text("id").primaryKey(),
  workspaceId: t.text("workspace_id").references(() => workspace.id, {
    onDelete: "cascade",
  }),
  url: t.text("url"),
  token: t.text("token"),
  createdAt: t.timestamp("created_at").notNull().defaultNow(),
  updatedAt: t.timestamp("updated_at").notNull().defaultNow(),
}));
