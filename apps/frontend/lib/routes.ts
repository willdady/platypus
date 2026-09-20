/**
 * The front-end route map, in one place.
 *
 * Every URL the app navigates to used to be a hand-interpolated template —
 * roughly a hundred of them across the front end, each free to drift from the
 * App Router tree it pointed at. These builders are the single definition of
 * those paths for the Organization, Workspace, and User scopes: a rename or a
 * moved segment changes one line here rather than every call site.
 *
 * Follows the API-side precedent of `scopedPath` (ADR-0007): a pure function
 * resolves a resource's path from its scope, so a component holds a route
 * value instead of re-deriving the shape at each use. Dynamic segments are
 * functions (`chat.detail(id)`); static ones are plain strings.
 */

/** Organization-scoped pages: the org root, workspace creation, and settings. */
export function orgRoutes(orgId: string) {
  const settings = `/${orgId}/settings`;
  return {
    root: `/${orgId}`,
    createWorkspace: `/${orgId}/create`,
    settings: {
      root: settings,
      members: `${settings}/members`,
      invitations: `${settings}/invitations`,
      providers: `${settings}/providers`,
      mcp: `${settings}/mcp`,
      createMcp: `${settings}/mcp/create`,
      mcpDetail: (mcpId: string) => `${settings}/mcp/${mcpId}`,
      skills: `${settings}/skills`,
      skillDetail: (skillId: string) => `${settings}/skills/${skillId}`,
      agents: `${settings}/agents`,
      agentDetail: (agentId: string) => `${settings}/agents/${agentId}`,
      blueprints: `${settings}/blueprints`,
      createBlueprint: `${settings}/blueprints/create`,
      blueprintDetail: (blueprintId: string) =>
        `${settings}/blueprints/${blueprintId}`,
      plugins: `${settings}/plugins`,
    },
  };
}

/** Pages under one Workspace. */
export function workspaceRoutes(orgId: string, workspaceId: string) {
  const root = `/${orgId}/workspace/${workspaceId}`;
  const settings = `${root}/settings`;
  return {
    root,
    chat: {
      root: `${root}/chat`,
      detail: (chatId: string) => `${root}/chat/${chatId}`,
      /** A new chat pre-selecting one Agent. */
      forAgent: (agentId: string) =>
        `${root}/chat?agentId=${encodeURIComponent(agentId)}`,
    },
    agents: {
      create: `${root}/agents/create`,
      detail: (agentId: string) => `${root}/agents/${agentId}`,
    },
    skills: {
      root: `${root}/skills`,
      create: `${root}/skills/create`,
    },
    boards: {
      root: `${root}/boards`,
      create: `${root}/boards/create`,
      detail: (boardId: string) => `${root}/boards/${boardId}`,
      settings: (boardId: string) => `${root}/boards/${boardId}/settings`,
    },
    dashboards: {
      create: `${root}/dashboards/create`,
      detail: (dashboardId: string) => `${root}/dashboards/${dashboardId}`,
      settings: (dashboardId: string) =>
        `${root}/dashboards/${dashboardId}/settings`,
    },
    triggers: {
      create: `${root}/triggers/create`,
      detail: (triggerId: string) => `${root}/triggers/${triggerId}`,
    },
    triggerRuns: {
      root: `${root}/trigger-runs`,
      detail: (runId: string) => `${root}/trigger-runs/${runId}`,
      /** The run list filtered to one Trigger. */
      forTrigger: (triggerId: string) =>
        `${root}/trigger-runs?triggerId=${encodeURIComponent(triggerId)}`,
    },
    settings: {
      root: settings,
      providers: `${settings}/providers`,
      mcp: `${settings}/mcp`,
      createMcp: `${settings}/mcp/create`,
      mcpDetail: (mcpId: string) => `${settings}/mcp/${mcpId}`,
      sandbox: `${settings}/sandbox`,
      webhooks: `${settings}/webhooks`,
      createWebhook: `${settings}/webhooks/create`,
      webhookDetail: (webhookId: string) => `${settings}/webhooks/${webhookId}`,
      about: `${settings}/about`,
    },
  };
}

/** The User's own settings, outside any Organization. */
export const userRoutes = {
  profile: "/settings",
  contexts: "/settings/contexts",
  createContext: "/settings/contexts/create",
  contextDetail: (contextId: string) => `/settings/contexts/${contextId}`,
  security: "/settings/security",
  invitations: "/settings/invitations",
  users: "/settings/users",
} as const;
