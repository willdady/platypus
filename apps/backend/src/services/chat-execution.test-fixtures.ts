import type { ChatTurnQueries } from "./chat-execution.ts";
import type {
  agent as agentTable,
  mcp as mcpTable,
  organization as organizationTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import type { Provider } from "@platypus/schemas";
import type { MemorySummary } from "./memory-retrieval.ts";

type AgentRow = typeof agentTable.$inferSelect;
type WorkspaceRow = typeof workspaceTable.$inferSelect;
type OrganizationRow = typeof organizationTable.$inferSelect;
type McpRow = typeof mcpTable.$inferSelect;

export type ChatTurnQueriesFixtures = {
  workspaces?: WorkspaceRow[];
  organizations?: OrganizationRow[];
  agents?: AgentRow[];
  providers?: Provider[];
  skills?: Array<{
    id: string;
    workspaceId?: string | null;
    organizationId?: string | null;
    name: string;
    description: string;
    disableModelInvocation?: boolean;
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

  /**
   * The visibility rule every lookup applies, as `resolveScoped` does:
   * Workspace-scoped in the invoking workspace, or org-scoped (Shared) and
   * attached here (ADR-0007). A row carrying both scope columns belongs to its
   * Workspace, so it is not Shared.
   */
  const isVisible = (
    resourceType: "mcp" | "provider" | "skill" | "agent",
    row: {
      id: string;
      workspaceId?: string | null;
      organizationId?: string | null;
    },
    orgId: string,
    workspaceId: string,
  ): boolean =>
    row.workspaceId === workspaceId ||
    (row.organizationId === orgId &&
      !row.workspaceId &&
      isAttached(resourceType, row.id, workspaceId));

  const isAgentVisible = (a: AgentRow, orgId: string, workspaceId: string) =>
    isVisible("agent", a, orgId, workspaceId);

  return {
    getWorkspace(id) {
      return Promise.resolve(fx.workspaces?.find((w) => w.id === id) ?? null);
    },

    getOrganization(id) {
      return Promise.resolve(
        fx.organizations?.find((o) => o.id === id) ?? null,
      );
    },

    getAgent(id, orgId, workspaceId) {
      const a = fx.agents?.find((a) => a.id === id) ?? null;
      if (!a) return Promise.resolve(null);
      return Promise.resolve(isAgentVisible(a, orgId, workspaceId) ? a : null);
    },

    getProvider(id, orgId, workspaceId) {
      const p = fx.providers?.find((p) => p.id === id);
      return Promise.resolve(
        p && isVisible("provider", p, orgId, workspaceId) ? p : null,
      );
    },

    getSkillsByIds(ids, orgId, workspaceId) {
      if (ids.length === 0) {
        return Promise.resolve({ skills: [], permittedSkillIds: [] });
      }
      const visible = (fx.skills ?? []).filter(
        (s) => ids.includes(s.id) && isVisible("skill", s, orgId, workspaceId),
      );
      // A Workspace Skill wins a name collision with an attached Shared one,
      // as the real query does; both stay loadable by id.
      const workspaceNames = new Set(
        visible.filter((s) => s.workspaceId === workspaceId).map((s) => s.name),
      );
      const advertised = visible.filter(
        (s) => s.workspaceId === workspaceId || !workspaceNames.has(s.name),
      );
      return Promise.resolve({
        skills: advertised
          .filter((s) => !s.disableModelInvocation)
          .map((s) => ({ name: s.name, description: s.description })),
        permittedSkillIds: visible.map((s) => s.id),
      });
    },

    getMcp(id, orgId, workspaceId) {
      const m = fx.mcps?.find((m) => m.id === id);
      return Promise.resolve(
        m && isVisible("mcp", m, orgId, workspaceId) ? m : null,
      );
    },

    getSubAgentsByIds(ids, orgId, workspaceId) {
      if (ids.length === 0) return Promise.resolve([]);
      // Same rule as getAgent — a sub-agent resolves in the invoking workspace,
      // or at org scope where attached (ADR-0007). Enforced here rather than
      // filtering by id alone, so tests exercise the boundary, not a hole in it.
      const visible = (fx.agents ?? []).filter((a) =>
        isAgentVisible(a, orgId, workspaceId),
      );
      return Promise.resolve(
        ids
          .map((id) => visible.find((a) => a.id === id))
          .filter((a): a is AgentRow => a !== undefined),
      );
    },

    getUserContexts(userId, workspaceId) {
      let global: string | undefined;
      let workspace: string | undefined;
      for (const ctx of fx.userContexts ?? []) {
        if (ctx.userId !== userId) continue;
        if (ctx.workspaceId === null) global = ctx.content;
        else if (ctx.workspaceId === workspaceId) workspace = ctx.content;
      }
      return Promise.resolve({ global, workspace });
    },

    getRecentMemories(userId, workspaceId, _referenceDate) {
      return Promise.resolve(
        (fx.memories ?? [])
          .filter((m) => m.userId === userId && m.workspaceId === workspaceId)
          .map(
            ({ userId: _u, workspaceId: _w, ...rest }) => rest as MemorySummary,
          ),
      );
    },

    getSandboxEnvKeys(workspaceId) {
      return Promise.resolve(fx.sandboxEnvKeys?.[workspaceId] ?? []);
    },
  };
};
