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

/**
 * Prefix an app path with the deployment's `BASE_PATH`.
 *
 * `next/link` and the router add the base path themselves, so this is only for
 * the places they don't reach: `window.location`, `history`, absolute URLs
 * handed to someone else, and metadata such as the manifest. Read at call time
 * so tests can stub it; Next inlines `NEXT_PUBLIC_BASE_PATH` at build.
 */
export function withBasePath(path: string): string {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  if (!basePath) return path;
  return path === "/" ? basePath : `${basePath}${path}`;
}

/**
 * The inverse of `withBasePath`: the app path under `BASE_PATH` that a
 * same-origin pathname points at, or null when it lies outside the app.
 */
export function stripBasePath(pathname: string): string | null {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  if (!basePath) return pathname;
  if (!`${pathname}/`.startsWith(`${basePath}/`)) return null;
  return pathname.slice(basePath.length) || "/";
}

/** App-level pages outside any Organization. */
export const appRoutes = {
  home: "/",
  signIn: "/sign-in",
  signUp: "/sign-up",
  createOrganization: "/create",
  /** The bare invite address an invitation page scrubs its token down to. */
  invite: "/invite",
  inviteToken: (token: string) => `/invite/${encodeURIComponent(token)}`,
} as const;

/** Sign-in, returning to `path` once signed in. */
export function signInReturningTo(path: string): string {
  return `${appRoutes.signIn}?next=${encodeURIComponent(path)}`;
}

/**
 * Where sign-in goes on to, given its query string: `next` when it resolves to
 * a path on this origin, home otherwise. Honouring any `next` would make
 * sign-in an open redirect.
 */
export function signInDestination(search: string): string {
  const next = new URLSearchParams(search).get("next");
  if (!next) return appRoutes.home;
  // Resolved against a stand-in origin: `//host`, `/\\host` and absolute
  // URLs all resolve somewhere else, and so fail the comparison.
  const origin = "http://platypus.invalid";
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return appRoutes.home;
  }
  return url.origin === origin
    ? `${url.pathname}${url.search}${url.hash}`
    : appRoutes.home;
}

/** The absolute invitation link to hand to an invitee. */
export function invitationLink(origin: string, token: string): string {
  return `${origin}${withBasePath(appRoutes.inviteToken(token))}`;
}

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
      installSkills: `${settings}/skills/install`,
      skillDetail: (skillId: string) => `${settings}/skills/${skillId}`,
      agents: `${settings}/agents`,
      agentDetail: (agentId: string) => `${settings}/agents/${agentId}`,
      blueprints: `${settings}/blueprints`,
      createBlueprint: `${settings}/blueprints/create`,
      blueprintDetail: (blueprintId: string) =>
        `${settings}/blueprints/${blueprintId}`,
      plugins: `${settings}/plugins`,
      inboundTriggers: `${settings}/inbound-triggers`,
      a2a: `${settings}/a2a`,
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
      install: `${root}/skills/install`,
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
      a2aEndpoints: `${settings}/a2a-endpoints`,
      createA2aEndpoint: `${settings}/a2a-endpoints/create`,
      a2aEndpointDetail: (endpointId: string) =>
        `${settings}/a2a-endpoints/${endpointId}`,
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
