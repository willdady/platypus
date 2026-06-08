import type { ChatTurnQueries } from "./chat-execution.ts";
import type {
  agent as agentTable,
  mcp as mcpTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import type { Provider } from "@platypus/schemas";
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
    workspaceId?: string | null;
    organizationId?: string | null;
    name: string;
    description: string;
  }>;
  mcps?: McpRow[];
  // Attachments of org-scoped Shared resources to workspaces (ADR-0007). An
  // org-scoped Provider/MCP/Skill resolves at Chat-turn time only where attached.
  attachments?: Array<{
    workspaceId: string;
    resourceType: "mcp" | "provider" | "skill" | "agent";
    resourceId: string;
  }>;
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
): ChatTurnQueries => {
  const isAttached = (
    resourceType: "mcp" | "provider" | "skill" | "agent",
    resourceId: string,
    workspaceId: string,
  ) =>
    (fx.attachments ?? []).some(
      (a) =>
        a.resourceType === resourceType &&
        a.resourceId === resourceId &&
        a.workspaceId === workspaceId,
    );

  return {
    async getWorkspace(id) {
      return fx.workspaces?.find((w) => w.id === id) ?? null;
    },

    async getAgent(id, orgId, workspaceId) {
      const a = fx.agents?.find((a) => a.id === id) ?? null;
      if (!a) return null;
      // Workspace-scoped Agent in this workspace.
      if (a.workspaceId === workspaceId) return a;
      // Org-scoped (Shared) Agent resolves only where attached (ADR-0007).
      if (
        a.organizationId === orgId &&
        !a.workspaceId &&
        isAttached("agent", id, workspaceId)
      ) {
        return a;
      }
      return null;
    },

    async getProvider(id, orgId, workspaceId) {
      const p =
        fx.providers?.find(
          (p) =>
            p.id === id &&
            (p.workspaceId === workspaceId || p.organizationId === orgId),
        ) ?? null;
      if (!p) return null;
      // Org-scoped (no workspace) → resolves only where attached (ADR-0007).
      if (
        p.organizationId &&
        !p.workspaceId &&
        !isAttached("provider", id, workspaceId)
      )
        return null;
      return p;
    },

    async getSkillsByIds(ids, orgId, workspaceId) {
      if (ids.length === 0) return [];
      return (fx.skills ?? [])
        .filter((s) => {
          if (!ids.includes(s.id)) return false;
          // Workspace-scoped Skill in this workspace.
          if (s.workspaceId === workspaceId) return true;
          // Org-scoped (Shared) Skill resolves only where attached (ADR-0007).
          return (
            s.organizationId === orgId &&
            !s.workspaceId &&
            isAttached("skill", s.id, workspaceId)
          );
        })
        .map((s) => ({ name: s.name, description: s.description }));
    },

    async getMcp(id, orgId, workspaceId) {
      const m =
        fx.mcps?.find(
          (m) =>
            m.id === id &&
            (m.workspaceId === workspaceId || m.organizationId === orgId),
        ) ?? null;
      if (!m) return null;
      // Org-scoped (no workspace) → resolves only where attached (ADR-0007).
      if (
        m.organizationId &&
        !m.workspaceId &&
        !isAttached("mcp", id, workspaceId)
      )
        return null;
      return m;
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
        .map(
          ({ userId: _u, workspaceId: _w, ...rest }) => rest as MemorySummary,
        );
    },

    async getSandboxEnvKeys(workspaceId) {
      return fx.sandboxEnvKeys?.[workspaceId] ?? [];
    },
  };
};
