// why: next/link adds the base path; this is for window.location and hand-built URLs
export function withBasePath(path: string): string {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  if (!basePath) return path;
  return path === "/" ? basePath : `${basePath}${path}`;
}

export function stripBasePath(pathname: string): string | null {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  if (!basePath) return pathname;
  if (!`${pathname}/`.startsWith(`${basePath}/`)) return null;
  return pathname.slice(basePath.length) || "/";
}

export const appRoutes = {
  home: "/",
  signIn: "/sign-in",
  signUp: "/sign-up",
  createOrganization: "/create",
  invite: "/invite",
  inviteToken: (token: string) => `/invite/${encodeURIComponent(token)}`,
} as const;

export function signInReturningTo(path: string): string {
  return `${appRoutes.signIn}?next=${encodeURIComponent(path)}`;
}

export function signInDestination(search: string): string {
  const next = new URLSearchParams(search).get("next");
  if (!next) return appRoutes.home;
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

export function invitationLink(origin: string, token: string): string {
  return `${origin}${withBasePath(appRoutes.inviteToken(token))}`;
}

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
      inboundTriggers: `${settings}/inbound-triggers`,
      a2a: `${settings}/a2a`,
    },
  };
}

export function workspaceRoutes(orgId: string, workspaceId: string) {
  const root = `/${orgId}/workspace/${workspaceId}`;
  const settings = `${root}/settings`;
  return {
    root,
    chat: {
      root: `${root}/chat`,
      detail: (chatId: string) => `${root}/chat/${chatId}`,
      forAgent: (agentId: string) =>
        `${root}/chat?agentId=${encodeURIComponent(agentId)}`,
    },
    agents: {
      root: `${root}/agents`,
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
    artifacts: {
      root: `${root}/artifacts`,
      detail: (artifactId: string) => `${root}/artifacts/${artifactId}`,
    },
    triggers: {
      root: `${root}/triggers`,
      create: `${root}/triggers/create`,
      detail: (triggerId: string) => `${root}/triggers/${triggerId}`,
    },
    triggerRuns: {
      root: `${root}/trigger-runs`,
      detail: (runId: string) => `${root}/trigger-runs/${runId}`,
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

// why: mirrors the (sidebar) route group, which renders boundaries above it
export function isWorkspaceSidebarRoute(pathname: string) {
  return /^\/[^/]+\/workspace\/[^/]+(\/chat(\/[^/]+)?)?\/?$/.test(pathname);
}

export const userRoutes = {
  profile: "/settings",
  contexts: "/settings/contexts",
  createContext: "/settings/contexts/create",
  contextDetail: (contextId: string) => `/settings/contexts/${contextId}`,
  security: "/settings/security",
  invitations: "/settings/invitations",
  users: "/settings/users",
} as const;
