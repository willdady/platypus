// @vitest-environment node
import { describe, it, expect } from "vitest";
import { orgRoutes, workspaceRoutes, userRoutes } from "./routes";

describe("orgRoutes", () => {
  const routes = orgRoutes("org1");

  it("builds the organization root and workspace-creation paths", () => {
    expect(routes.root).toBe("/org1");
    expect(routes.createWorkspace).toBe("/org1/create");
  });

  it("builds every organization settings list path", () => {
    expect(routes.settings.root).toBe("/org1/settings");
    expect(routes.settings.members).toBe("/org1/settings/members");
    expect(routes.settings.invitations).toBe("/org1/settings/invitations");
    expect(routes.settings.providers).toBe("/org1/settings/providers");
    expect(routes.settings.mcp).toBe("/org1/settings/mcp");
    expect(routes.settings.skills).toBe("/org1/settings/skills");
    expect(routes.settings.agents).toBe("/org1/settings/agents");
    expect(routes.settings.blueprints).toBe("/org1/settings/blueprints");
    expect(routes.settings.plugins).toBe("/org1/settings/plugins");
  });

  it("builds the organization settings create paths", () => {
    expect(routes.settings.createMcp).toBe("/org1/settings/mcp/create");
    expect(routes.settings.createBlueprint).toBe(
      "/org1/settings/blueprints/create",
    );
  });

  it("builds the organization settings detail paths", () => {
    expect(routes.settings.mcpDetail("m1")).toBe("/org1/settings/mcp/m1");
    expect(routes.settings.skillDetail("s1")).toBe("/org1/settings/skills/s1");
    expect(routes.settings.agentDetail("a1")).toBe("/org1/settings/agents/a1");
    expect(routes.settings.blueprintDetail("b1")).toBe(
      "/org1/settings/blueprints/b1",
    );
  });

  it("exposes exactly the organization settings keys", () => {
    expect(Object.keys(routes.settings).sort()).toEqual([
      "agentDetail",
      "agents",
      "blueprintDetail",
      "blueprints",
      "createBlueprint",
      "createMcp",
      "invitations",
      "mcp",
      "mcpDetail",
      "members",
      "plugins",
      "providers",
      "root",
      "skillDetail",
      "skills",
    ]);
  });

  it("scopes every path to the given organization", () => {
    const other = orgRoutes("org2");
    expect(other.root).toBe("/org2");
    expect(other.createWorkspace).toBe("/org2/create");
    expect(other.settings.members).toBe("/org2/settings/members");
    expect(other.settings.agentDetail("a1")).toBe("/org2/settings/agents/a1");
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
    expect(routes.chat.forAgent("a1")).toBe(
      "/org1/workspace/ws1/chat?agentId=a1",
    );
  });

  it("builds the collection roots", () => {
    expect(routes.skills.root).toBe("/org1/workspace/ws1/skills");
    expect(routes.boards.root).toBe("/org1/workspace/ws1/boards");
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
    expect(routes.agents.detail("a1")).toBe("/org1/workspace/ws1/agents/a1");
    expect(routes.boards.detail("b1")).toBe("/org1/workspace/ws1/boards/b1");
    expect(routes.dashboards.detail("d1")).toBe(
      "/org1/workspace/ws1/dashboards/d1",
    );
    expect(routes.triggers.detail("t1")).toBe(
      "/org1/workspace/ws1/triggers/t1",
    );
  });

  it("builds the per-item settings paths", () => {
    expect(routes.boards.settings("b1")).toBe(
      "/org1/workspace/ws1/boards/b1/settings",
    );
    expect(routes.dashboards.settings("d1")).toBe(
      "/org1/workspace/ws1/dashboards/d1/settings",
    );
  });

  it("builds the trigger-runs paths", () => {
    expect(routes.triggerRuns.root).toBe("/org1/workspace/ws1/trigger-runs");
    expect(routes.triggerRuns.detail("r1")).toBe(
      "/org1/workspace/ws1/trigger-runs/r1",
    );
    expect(routes.triggerRuns.forTrigger("t1")).toBe(
      "/org1/workspace/ws1/trigger-runs?triggerId=t1",
    );
  });

  it("escapes ids interpolated into a query string", () => {
    expect(routes.triggerRuns.forTrigger("a b&c")).toBe(
      "/org1/workspace/ws1/trigger-runs?triggerId=a%20b%26c",
    );
    expect(routes.chat.forAgent("a b&c")).toBe(
      "/org1/workspace/ws1/chat?agentId=a%20b%26c",
    );
  });

  it("builds every workspace settings list path", () => {
    expect(routes.settings.root).toBe("/org1/workspace/ws1/settings");
    expect(routes.settings.providers).toBe(
      "/org1/workspace/ws1/settings/providers",
    );
    expect(routes.settings.mcp).toBe("/org1/workspace/ws1/settings/mcp");
    expect(routes.settings.sandbox).toBe(
      "/org1/workspace/ws1/settings/sandbox",
    );
    expect(routes.settings.webhooks).toBe(
      "/org1/workspace/ws1/settings/webhooks",
    );
    expect(routes.settings.about).toBe("/org1/workspace/ws1/settings/about");
  });

  it("builds the workspace settings create and detail paths", () => {
    expect(routes.settings.createMcp).toBe(
      "/org1/workspace/ws1/settings/mcp/create",
    );
    expect(routes.settings.mcpDetail("m1")).toBe(
      "/org1/workspace/ws1/settings/mcp/m1",
    );
    expect(routes.settings.createWebhook).toBe(
      "/org1/workspace/ws1/settings/webhooks/create",
    );
    expect(routes.settings.webhookDetail("w1")).toBe(
      "/org1/workspace/ws1/settings/webhooks/w1",
    );
  });

  it("exposes exactly the workspace settings keys", () => {
    expect(Object.keys(routes.settings).sort()).toEqual([
      "about",
      "createMcp",
      "createWebhook",
      "mcp",
      "mcpDetail",
      "providers",
      "root",
      "sandbox",
      "webhookDetail",
      "webhooks",
    ]);
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
    expect(userRoutes.profile).toBe("/settings");
    expect(userRoutes.contexts).toBe("/settings/contexts");
    expect(userRoutes.security).toBe("/settings/security");
    expect(userRoutes.invitations).toBe("/settings/invitations");
    expect(userRoutes.users).toBe("/settings/users");
  });

  it("builds the workspace-context create and detail paths", () => {
    expect(userRoutes.createContext).toBe("/settings/contexts/create");
    expect(userRoutes.contextDetail("wc1")).toBe("/settings/contexts/wc1");
  });
});
