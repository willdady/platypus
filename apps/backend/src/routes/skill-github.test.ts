import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockSession, resetMockDb, seedDb } from "../test-utils.ts";
import app from "../server.ts";
import {
  installGithubSkills,
  previewGithubSkills,
} from "../services/skill-github.ts";

vi.mock("../services/skill-github.ts", () => ({
  previewGithubSkills: vi.fn(),
  installGithubSkills: vi.fn(),
}));

/**
 * The Skill import gate (ADR-0037) and the GitHub install routes: who may
 * import a bundle into a Workspace, and what reaches the install service.
 */
const orgId = "org-1";
const workspaceId = "ws-1";
const skillsUrl = `/organizations/${orgId}/workspaces/${workspaceId}/skills`;
const orgSkillsUrl = `/organizations/${orgId}/skills`;

const SHA = "a".repeat(40);
const installBody = {
  owner: "acme",
  repo: "skills",
  ref: null,
  commitSha: SHA,
  skillPaths: ["skills/pdf"],
};

const seed = (gate: string, allowed: boolean, role = "member") =>
  seedDb({
    organization: [{ id: orgId, name: "Acme", skillImportGate: gate }],
    user: [{ id: "user-1", name: "Dana Owner" }],
    organization_member: [
      { id: "m1", userId: "user-1", organizationId: orgId, role },
    ],
    workspace: [
      {
        id: workspaceId,
        name: "Support",
        organizationId: orgId,
        ownerId: "user-1",
        skillImportAllowed: allowed,
      },
    ],
    skill: [
      {
        id: "skill-1",
        workspaceId,
        organizationId: null,
        name: "web",
        description: "d",
        body: "b",
        frontmatter: {},
      },
    ],
  });

const post = (url: string, body: unknown, json = true) =>
  app.request(url, {
    method: "POST",
    body: json ? JSON.stringify(body) : Buffer.from(body as Uint8Array),
    headers: {
      "Content-Type": json ? "application/json" : "application/zip",
    },
  });

/** Every Workspace-scope import, sent as a Workspace Owner would. */
const imports = {
  "zip import": () => post(`${skillsUrl}/import`, new Uint8Array([1]), false),
  "Replace bundle": () =>
    app.request(`${skillsUrl}/skill-1/bundle`, {
      method: "PUT",
      body: new Uint8Array([1]),
      headers: { "Content-Type": "application/zip" },
    }),
  "GitHub preview": () =>
    post(`${skillsUrl}/github/preview`, { source: "acme/skills" }),
  "GitHub install": () => post(`${skillsUrl}/github/install`, installBody),
};

beforeEach(() => {
  resetMockDb();
  vi.clearAllMocks();
  vi.mocked(previewGithubSkills).mockResolvedValue({
    owner: "acme",
    repo: "skills",
    ref: null,
    path: "",
    commitSha: SHA,
    skills: [],
  });
  vi.mocked(installGithubSkills).mockResolvedValue({ results: [] });
});

describe("the Skill import gate", () => {
  // A bad zip is a 400 past the gate; a GitHub route is a 200.
  const passed = (status: number) => expect([200, 400]).toContain(status);

  it.each(Object.entries(imports))(
    "refuses %s under `off`",
    async (_label, send) => {
      seed("off", true);
      mockSession();
      const res = await send();
      expect(res.status).toBe(403);
      expect(previewGithubSkills).not.toHaveBeenCalled();
      expect(installGithubSkills).not.toHaveBeenCalled();
    },
  );

  it.each(Object.entries(imports))(
    "admits %s under `selected` only where the Workspace is allowed",
    async (_label, send) => {
      seed("selected", false);
      mockSession();
      expect((await send()).status).toBe(403);

      resetMockDb();
      seed("selected", true);
      passed((await send()).status);
    },
  );

  it.each(Object.entries(imports))(
    "admits %s under `all`",
    async (_l, send) => {
      seed("all", false);
      mockSession();
      passed((await send()).status);
    },
  );

  it.each(["off", "selected", "all"])(
    "never gates an Org Admin at Organization scope (%s)",
    async (gate) => {
      seed(gate, false, "admin");
      mockSession();
      expect(
        (await post(`${orgSkillsUrl}/import`, new Uint8Array([1]), false))
          .status,
      ).toBe(400);
      expect(
        (
          await post(`${orgSkillsUrl}/github/preview`, {
            source: "acme/skills",
          })
        ).status,
      ).toBe(200);
      expect(
        (await post(`${orgSkillsUrl}/github/install`, installBody)).status,
      ).toBe(200);
    },
  );

  it("can be read and set by an Org Admin, with the Workspace switches", async () => {
    const fake = seed("all", false, "admin");
    mockSession();
    const res = await app.request(
      `/organizations/${orgId}/skill-import/access`,
      {
        method: "PUT",
        body: JSON.stringify({
          gate: "selected",
          allowedWorkspaceIds: [workspaceId],
        }),
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      gate: "selected",
      workspaces: [{ id: workspaceId, allowed: true, count: 1 }],
    });
    expect(fake.tables.organization[0].skillImportGate).toBe("selected");
  });

  it("can't be read or set by a member", async () => {
    const fake = seed("all", false);
    mockSession();
    const url = `/organizations/${orgId}/skill-import/access`;
    expect((await app.request(url)).status).toBe(403);
    const res = await app.request(url, {
      method: "PUT",
      body: JSON.stringify({ gate: "off" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(fake.tables.organization[0].skillImportGate).toBe("all");
  });

  it("can't be changed through the Workspace's own settings", async () => {
    const fake = seed("selected", false);
    mockSession();
    await app.request(`/organizations/${orgId}/workspaces/${workspaceId}`, {
      method: "PUT",
      body: JSON.stringify({ name: "Support", skillImportAllowed: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(fake.tables.workspace[0].skillImportAllowed).toBe(false);
  });
});

describe("the GitHub routes", () => {
  it("hands a preview its source and scope", async () => {
    seed("all", false);
    mockSession();
    const res = await post(`${skillsUrl}/github/preview`, {
      source: "acme/skills",
    });
    expect(res.status).toBe(200);
    expect(previewGithubSkills).toHaveBeenCalledWith(
      {
        kind: "workspace",
        ctx: expect.objectContaining({ orgId, workspaceId }),
      },
      "acme/skills",
    );
  });

  it.each([
    ["an owner with a host", { owner: "evil.example/acme" }],
    ["a repo of '..'", { repo: ".." }],
    ["a ref with '..'", { ref: "main/../x" }],
    ["a path climbing out", { skillPaths: ["../x"] }],
    ["a path with a control character", { skillPaths: ["a\u0001b"] }],
    ["a ref that isn't a SHA", { commitSha: "main" }],
    [
      "more than 50 Skills",
      { skillPaths: Array.from({ length: 51 }, (_, i) => `s${i}`) },
    ],
  ])("refuses an install naming %s with a 400", async (_label, change) => {
    seed("all", false);
    mockSession();
    const res = await post(`${skillsUrl}/github/install`, {
      ...installBody,
      ...change,
    });
    expect(res.status).toBe(400);
    expect(installGithubSkills).not.toHaveBeenCalled();
  });

  it("refuses an Organization-scope install from a member", async () => {
    seed("all", false);
    mockSession();
    const res = await post(`${orgSkillsUrl}/github/install`, installBody);
    expect(res.status).toBe(403);
    expect(installGithubSkills).not.toHaveBeenCalled();
  });
});
