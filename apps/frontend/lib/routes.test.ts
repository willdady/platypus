import { describe, it, expect } from "vitest";
import { orgRoutes, workspaceRoutes, userRoutes } from "./routes";

describe("orgRoutes", () => {
  const routes = orgRoutes("org1");

  it("builds the organization root and workspace-creation paths", () => {
    expect(routes.root).toBe("/org1");
    expect(routes.createWorkspace).toBe("/org1/create");
  });

  it("builds every organization settings path", () => {
    expect(routes.settings).toEqual({
      root: "/org1/settings",
      members: "/org1/settings/members",
      invitations: "/org1/settings/invitations",
      providers: "/org1/settings/providers",
      mcp: "/org1/settings/mcp",
      skills: "/org1/settings/skills",
      agents: "/org1/settings/agents",
      blueprints: "/org1/settings/blueprints",
      plugins: "/org1/settings/plugins",
    });
  });

  it("scopes every path to the given organization", () => {
    const other = orgRoutes("org2");
    expect(other.root).toBe("/org2");
    expect(other.createWorkspace).toBe("/org2/create");
    expect(other.settings.members).toBe("/org2/settings/members");
  });
});

describe("workspaceRoutes", () => {
  const routes = workspaceRoutes("org1", "ws1");

  it("builds the workspace root", () => {
    expect(routes.root).toBe("/org1/workspace/ws1");
  });

  it("builds chat paths", () => {
    expect(routes.chat.root).toBe("/org1/workspace/ws1/chat");
    expect(routes.chat.detail("c1")).toBe("/org1/workspace/ws1/chat/c1");
  });

  it("builds the create paths", () => {
    expect(routes.agents.create).toBe("/org1/workspace/ws1/agents/create");
    expect(routes.skills.create).toBe("/org1/workspace/ws1/skills/create");
    expect(routes.boards.create).toBe("/org1/workspace/ws1/boards/create");
    expect(routes.dashboards.create).toBe(
      "/org1/workspace/ws1/dashboards/create",
    );
    expect(routes.triggers.create).toBe("/org1/workspace/ws1/triggers/create");
  });

  it("builds item paths", () => {
    expect(routes.boards.detail("b1")).toBe("/org1/workspace/ws1/boards/b1");
    expect(routes.triggers.detail("t1")).toBe("/org1/workspace/ws1/triggers/t1");
  });

  it("builds the trigger-runs path", () => {
    expect(routes.triggerRuns.root).toBe("/org1/workspace/ws1/trigger-runs");
  });

  it("builds every workspace settings path", () => {
    expect(routes.settings).toEqual({
      root: "/org1/workspace/ws1/settings",
      providers: "/org1/workspace/ws1/settings/providers",
      mcp: "/org1/workspace/ws1/settings/mcp",
      sandbox: "/org1/workspace/ws1/settings/sandbox",
      webhooks: "/org1/workspace/ws1/settings/webhooks",
      createWebhook: "/org1/workspace/ws1/settings/webhooks/create",
      about: "/org1/workspace/ws1/settings/about",
    });
  });

  it("scopes every path to the given org and workspace", () => {
    const other = workspaceRoutes("org2", "ws2");
    expect(other.root).toBe("/org2/workspace/ws2");
    expect(other.chat.detail("c1")).toBe("/org2/workspace/ws2/chat/c1");
    expect(other.settings.about).toBe("/org2/workspace/ws2/settings/about");
  });
});

describe("userRoutes", () => {
  it("builds the user-scoped settings paths", () => {
    expect(userRoutes).toEqual({
      profile: "/settings",
      contexts: "/settings/contexts",
      security: "/settings/security",
      invitations: "/settings/invitations",
      users: "/settings/users",
    });
  });
});
