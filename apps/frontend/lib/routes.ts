/**
 * The front-end route map, in one place.
 *
 * Every URL the app navigates to used to be a hand-interpolated template —
 * roughly a hundred of them across the front end, each free to drift from the
 * App Router tree it pointed at. These builders are the single definition of
 * those paths for the Organization, Workspace, and User scopes: a rename or a
 * moved segment changes one line here rather than every call site. The scopes
 * grow as their call sites migrate onto the builders.
 *
 * Follows the API-side precedent of `scopedPath` (ADR-0007): a pure function
 * resolves a resource's path from its scope, so a component holds a route
 * value instead of re-deriving the shape at each use. Dynamic segments are
 * functions (`chat.detail(id)`); static ones are plain strings.
 */

/** Organization-scoped pages: the org root, workspace creation, and settings. */
export function orgRoutes(orgId: string) {
  return {
    root: `/${orgId}`,
    createWorkspace: `/${orgId}/create`,
    settings: {
      root: `/${orgId}/settings`,
      members: `/${orgId}/settings/members`,
      invitations: `/${orgId}/settings/invitations`,
      providers: `/${orgId}/settings/providers`,
      mcp: `/${orgId}/settings/mcp`,
      skills: `/${orgId}/settings/skills`,
      agents: `/${orgId}/settings/agents`,
      blueprints: `/${orgId}/settings/blueprints`,
      plugins: `/${orgId}/settings/plugins`,
    },
  };
}

/** Pages under one Workspace. */
export function workspaceRoutes(orgId: string, workspaceId: string) {
  const root = `/${orgId}/workspace/${workspaceId}`;
  return {
    root,
    chat: {
      root: `${root}/chat`,
      detail: (chatId: string) => `${root}/chat/${chatId}`,
    },
    agents: {
      create: `${root}/agents/create`,
    },
    skills: {
      create: `${root}/skills/create`,
    },
    boards: {
      create: `${root}/boards/create`,
      detail: (boardId: string) => `${root}/boards/${boardId}`,
    },
    dashboards: {
      create: `${root}/dashboards/create`,
    },
    triggers: {
      create: `${root}/triggers/create`,
      detail: (triggerId: string) => `${root}/triggers/${triggerId}`,
    },
    triggerRuns: {
      root: `${root}/trigger-runs`,
    },
    settings: {
      root: `${root}/settings`,
      providers: `${root}/settings/providers`,
      mcp: `${root}/settings/mcp`,
      sandbox: `${root}/settings/sandbox`,
      webhooks: `${root}/settings/webhooks`,
      createWebhook: `${root}/settings/webhooks/create`,
      about: `${root}/settings/about`,
    },
  };
}

/** The User's own settings, outside any Organization. */
export const userRoutes = {
  profile: "/settings",
  contexts: "/settings/contexts",
  security: "/settings/security",
  invitations: "/settings/invitations",
  users: "/settings/users",
} as const;
