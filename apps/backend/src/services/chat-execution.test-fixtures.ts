import type { ChatTurnQueries } from "./chat-execution.ts";
import type {
  agent as agentTable,
  mcp as mcpTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import type { Provider, Skill } from "@platypus/schemas";
import type { MemorySummary } from "./memory-retrieval.ts";

type AgentRow = typeof agentTable.$inferSelect;
type WorkspaceRow = typeof workspaceTable.$inferSelect;
type McpRow = typeof mcpTable.$inferSelect;

export type ChatTurnQueriesFixtures = {
  workspaces?: WorkspaceRow[];
  agents?: AgentRow[];
  providers?: Provider[];
  skills?: Array<{
    id: string;
    workspaceId: string;
    name: string;
    description: string;
  }>;
  mcps?: McpRow[];
  userContexts?: Array<{
    userId: string;
    workspaceId: string | null;
    content: string;
  }>;
  memories?: Array<MemorySummary & { userId: string; workspaceId: string }>;
  sandboxEnvKeys?: Record<string, string[]>;
};

/**
 * Returns an in-memory `ChatTurnQueries` populated from explicit fixtures. Tests
 * specify only what they need; missing lookups return `null` / `[]`.
 */
export const createInMemoryChatTurnQueries = (
  fx: ChatTurnQueriesFixtures = {},
): ChatTurnQueries => ({
  async getWorkspace(id) {
    return fx.workspaces?.find((w) => w.id === id) ?? null;
  },

  async getAgent(id, workspaceId) {
    return (
      fx.agents?.find((a) => a.id === id && a.workspaceId === workspaceId) ??
      null
    );
  },

  async getProvider(id, orgId, workspaceId) {
    return (
      fx.providers?.find(
        (p) =>
          p.id === id &&
          (p.workspaceId === workspaceId || p.organizationId === orgId),
      ) ?? null
    );
  },

  async getSkillsByIds(ids, workspaceId) {
    if (ids.length === 0) return [];
    return (fx.skills ?? [])
      .filter((s) => s.workspaceId === workspaceId && ids.includes(s.id))
      .map((s) => ({ name: s.name, description: s.description }));
  },

  async getMcp(id, orgId, workspaceId) {
    return (
      fx.mcps?.find(
        (m) =>
          m.id === id &&
          (m.workspaceId === workspaceId || m.organizationId === orgId),
      ) ?? null
    );
  },

  async getSubAgentsByIds(ids) {
    if (ids.length === 0) return [];
    return (fx.agents ?? []).filter((a) => ids.includes(a.id));
  },

  async getUserContexts(userId, workspaceId) {
    let global: string | undefined;
    let workspace: string | undefined;
    for (const ctx of fx.userContexts ?? []) {
      if (ctx.userId !== userId) continue;
      if (ctx.workspaceId === null) global = ctx.content;
      else if (ctx.workspaceId === workspaceId) workspace = ctx.content;
    }
    return { global, workspace };
  },

  async getRecentMemories(userId, workspaceId) {
    return (fx.memories ?? [])
      .filter((m) => m.userId === userId && m.workspaceId === workspaceId)
      .map(({ userId: _u, workspaceId: _w, ...rest }) => rest as MemorySummary);
  },

  async getSandboxEnvKeys(workspaceId) {
    return fx.sandboxEnvKeys?.[workspaceId] ?? [];
  },
});
