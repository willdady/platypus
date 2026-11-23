import type { ChatTurnQueries } from "./chat-execution.ts";
import type {
  agent as agentTable,
  mcp as mcpTable,
  organization as organizationTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import type { ProviderRow } from "./provider-write.ts";
import type { AttachmentResourceType } from "@platypus/schemas";
import type { MemorySummary } from "./memory-retrieval.ts";

type AgentRow = typeof agentTable.$inferSelect;
type WorkspaceRow = typeof workspaceTable.$inferSelect;
type OrganizationRow = typeof organizationTable.$inferSelect;
type McpRow = typeof mcpTable.$inferSelect;

export type ChatTurnQueriesFixtures = {
  workspaces?: WorkspaceRow[];
  organizations?: OrganizationRow[];
  agents?: AgentRow[];
  providers?: ProviderRow[];
  skills?: Array<{
    id: string;
    workspaceId?: string | null;
    organizationId?: string | null;
    name: string;
    description: string;
    disableModelInvocation?: boolean;
  }>;
  mcps?: McpRow[];
  attachments?: Array<{
    workspaceId: string;
    resourceType: AttachmentResourceType;
    resourceId: string;
  }>;
  userContexts?: Array<{
    userId: string;
    workspaceId: string | null;
    content: string;
  }>;
  userTimezones?: Record<string, string>;
  memories?: Array<MemorySummary & { userId: string; workspaceId: string }>;
  sandboxEnvKeys?: Record<string, string[]>;
};

export const createInMemoryChatTurnQueries = (
  fx: ChatTurnQueriesFixtures = {},
): ChatTurnQueries => {
  const isAttached = (
    resourceType: AttachmentResourceType,
    resourceId: string,
    workspaceId: string,
  ) =>
    (fx.attachments ?? []).some(
      (a) =>
        a.resourceType === resourceType &&
        a.resourceId === resourceId &&
        a.workspaceId === workspaceId,
    );

  const isVisible = (
    resourceType: AttachmentResourceType,
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
      return Promise.resolve(
        isVisible("agent", a, orgId, workspaceId) ? a : null,
      );
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

    saveMcpToolListing() {
      return Promise.resolve();
    },

    setMcpFetchFailedAt() {
      return Promise.resolve();
    },

    getSubAgentsByIds(ids, orgId, workspaceId) {
      if (ids.length === 0) return Promise.resolve([]);
      const visible = (fx.agents ?? []).filter((a) =>
        isVisible("agent", a, orgId, workspaceId),
      );
      return Promise.resolve(
        ids
          .map((id) => visible.find((a) => a.id === id))
          .filter((a): a is AgentRow => a !== undefined),
      );
    },

    getUserTimezone(userId) {
      return Promise.resolve(fx.userTimezones?.[userId] ?? null);
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
          .map(({ summaryDate, summary }) => ({ summaryDate, summary })),
      );
    },

    getSandboxEnvKeys(workspaceId) {
      return Promise.resolve(fx.sandboxEnvKeys?.[workspaceId] ?? []);
    },
  };
};
