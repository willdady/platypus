import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockNoSession,
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
  type Store,
} from "../test-utils.ts";
import app from "../server.ts";

vi.mock("../services/skill-bundle.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/skill-bundle.ts")>()),
  rehashSkill: vi.fn((_db: unknown, row: unknown) => Promise.resolve(row)),
  listSkillFiles: vi.fn(() => Promise.resolve([])),
  skillFilesForApi: vi.fn(() => Promise.resolve([])),
}));

describe("Skill Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/skills`;

  const skillDescription = "This is a long enough description for the skill.";
  const skillBody =
    "This is a long enough body for the skill to pass the validation requirements.";

  const workspaceSkill = (over: Row = {}): Row => ({
    id: "skill-1",
    organizationId: null,
    workspaceId,
    name: "my-skill",
    description: skillDescription,
    body: skillBody,
    frontmatter: {},
    bundleHash: null,
    installedHash: null,
    ...over,
  });

  const sharedSkill = (over: Row = {}): Row =>
    workspaceSkill({
      id: "org-skill-1",
      name: "shared",
      organizationId: orgId,
      workspaceId: null,
      ...over,
    });

  const attachedHere = (resourceId: string): Row => ({
    id: `att-${resourceId}`,
    workspaceId,
    resourceType: "skill",
    resourceId,
  });

  const world = ({
    role = "member",
    owner = "user-1",
    rows = {},
  }: {
    role?: "admin" | "member";
    owner?: string;
    rows?: Store;
  } = {}): FakeDb =>
    seedDb({
      organization_member: [
        { id: "m1", userId: "user-1", organizationId: orgId, role },
      ],
      workspace: [{ id: workspaceId, organizationId: orgId, ownerId: owner }],
      ...rows,
    });

  const send = (
    method: "POST" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
  ) =>
    app.request(url, {
      method,
      ...(payload !== undefined && {
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      }),
    });

  const wrote = (fake: FakeDb, kind: "insert" | "update" | "delete") =>
    fake.queries.some((query) => query.kind === kind);

  describe("POST /", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "new-skill",
          description: "This is a long enough description for the skill.",
          body: "This is a long enough body for the skill to pass the validation requirements.",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it("should return 403 if user is not workspace owner", async () => {
      mockSession();
      world({ owner: "other-user" });

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "new-skill",
          description: "This is a long enough description for the skill.",
          body: "This is a long enough body for the skill to pass the validation requirements.",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
    });

    it("should create skill if user is editor", async () => {
      mockSession();
      const fake = world();

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "new-skill",
          description: "This is a long enough description for the skill.",
          body: "This is a long enough body for the skill to pass the validation requirements.",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      const created = fake.tables.skill.at(-1);
      expect(await res.json()).toEqual({ ...created, scope: "workspace" });
      expect(created).toMatchObject({
        name: "new-skill",
        description: "This is a long enough description for the skill.",
        body: "This is a long enough body for the skill to pass the validation requirements.",
        workspaceId,
        organizationId: null,
      });
      expect(wrote(fake, "insert")).toBe(true);
    });

    it("should return 400 if name is not kebab-case", async () => {
      mockSession();
      world();

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Invalid Name",
          body: "This is a long enough body for the skill to pass the validation requirements.",
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /", () => {
    it("should list workspace and attached org skills tagged with scope", async () => {
      mockSession();
      world({
        rows: {
          skill: [
            workspaceSkill({ id: "skill-1", name: "skill-1" }),
            workspaceSkill({
              id: "skill-elsewhere",
              name: "elsewhere",
              workspaceId: "ws-2",
            }),
            sharedSkill({ id: "org-skill-1", name: "org-skill-1" }),
            sharedSkill({ id: "org-skill-unattached", name: "unattached" }),
            sharedSkill({
              id: "org-skill-other-org",
              name: "foreign",
              organizationId: "org-2",
            }),
          ],
          attachment: [
            attachedHere("org-skill-1"),
            attachedHere("org-skill-other-org"),
          ],
        },
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { results: Row[] };
      expect(
        json.results.map(({ id, name, scope }) => ({ id, name, scope })),
      ).toEqual([
        { id: "skill-1", name: "skill-1", scope: "workspace" },
        {
          id: "org-skill-1",
          name: "org-skill-1",
          scope: "organization",
        },
      ]);
    });
  });

  describe("GET /:skillId", () => {
    it("returns a workspace skill tagged scope workspace with its agentIds", async () => {
      mockSession();
      world({
        rows: {
          skill: [
            workspaceSkill({ id: "skill-1", name: "my-skill" }),
            workspaceSkill({
              id: "skill-elsewhere",
              name: "elsewhere",
              workspaceId: "ws-2",
            }),
          ],
          agent: [
            { id: "agent-1", workspaceId, skillIds: ["skill-1"] },
            { id: "agent-2", workspaceId, skillIds: ["skill-elsewhere"] },
            {
              id: "agent-3",
              workspaceId: "ws-2",
              skillIds: ["skill-1"],
            },
          ],
        },
      });

      const res = await app.request(`${baseUrl}/skill-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: "skill-1",
        name: "my-skill",
        workspaceId,
        scope: "workspace",
        agentIds: ["agent-1"],
        files: [],
        modified: false,
      });
    });

    it("404s an org skill that is not attached here", async () => {
      mockSession();
      world({ rows: { skill: [sharedSkill()] } });

      const res = await app.request(`${baseUrl}/org-skill-1`);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:skillId", () => {
    const updateBody = {
      name: "renamed-skill",
      description: "This is a long enough description for the skill.",
      body: "This is a long enough body for the skill to pass the validation requirements.",
    };

    it("updates a workspace skill if user is editor", async () => {
      mockSession();
      const fake = world({ rows: { skill: [workspaceSkill()] } });

      const res = await send("PUT", `${baseUrl}/skill-1`, updateBody);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: "skill-1",
        name: "renamed-skill",
        workspaceId,
        scope: "workspace",
      });
      expect(fake.tables.skill[0]).toMatchObject({
        id: "skill-1",
        name: "renamed-skill",
        description: updateBody.description,
        body: updateBody.body,
      });
    });

    it("locks a shared skill in the workspace (edit on org surface)", async () => {
      mockSession();
      const fake = world({
        role: "admin",
        rows: {
          skill: [sharedSkill()],
          attachment: [attachedHere("org-skill-1")],
        },
      });

      const res = await send("PUT", `${baseUrl}/org-skill-1`, updateBody);
      expect(res.status).toBe(403);
      expect(wrote(fake, "update")).toBe(false);
    });
  });

  describe("POST /:skillId/promote", () => {
    const promoteUrl = `${baseUrl}/skill-1/promote`;

    it("returns 403 if not org admin", async () => {
      mockSession();
      world({ rows: { skill: [workspaceSkill()] } });

      const res = await app.request(promoteUrl, { method: "POST" });
      expect(res.status).toBe(403);
    });

    it("returns 404 if the workspace skill does not exist", async () => {
      mockSession();
      world({
        role: "admin",
        rows: { skill: [workspaceSkill({ workspaceId: "ws-2" })] },
      });

      const res = await app.request(promoteUrl, { method: "POST" });
      expect(res.status).toBe(404);
    });

    it("re-scopes the skill to org and auto-attaches the origin workspace", async () => {
      mockSession();
      const fake = world({
        role: "admin",
        rows: { skill: [workspaceSkill({ id: "skill-1", name: "my-skill" })] },
      });

      const res = await app.request(promoteUrl, { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: "skill-1",
        organizationId: orgId,
        workspaceId: null,
        scope: "organization",
      });
      expect(fake.tables.skill[0]).toMatchObject({
        id: "skill-1",
        organizationId: orgId,
        workspaceId: null,
      });
      expect(fake.tables.attachment).toEqual([
        expect.objectContaining({
          workspaceId,
          resourceType: "skill",
          resourceId: "skill-1",
        }),
      ]);
      expect(wrote(fake, "insert")).toBe(true);
    });
  });

  describe("DELETE /:skillId", () => {
    it("should 409 naming the agents that still use the skill", async () => {
      mockSession();
      const fake = world({
        rows: {
          skill: [
            workspaceSkill(),
            workspaceSkill({
              id: "skill-elsewhere",
              name: "elsewhere",
              workspaceId: "ws-2",
            }),
          ],
          agent: [
            {
              id: "agent-2",
              workspaceId,
              name: "Helper",
              skillIds: ["skill-1"],
            },
            {
              id: "agent-1",
              workspaceId,
              name: "Digest",
              skillIds: ["skill-1"],
            },
            {
              id: "agent-3",
              workspaceId,
              name: "Other",
              skillIds: ["skill-elsewhere"],
            },
            {
              id: "agent-4",
              workspaceId: "ws-2",
              name: "Elsewhere",
              skillIds: ["skill-1"],
            },
          ],
        },
      });

      const res = await app.request(`${baseUrl}/skill-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          'Cannot delete: this skill is enabled for 2 agents ("Digest", "Helper"). Turn it off for those agents first.',
      });
      expect(wrote(fake, "delete")).toBe(false);
    });

    it("should delete skill if not referenced", async () => {
      mockSession();
      const fake = world({ rows: { skill: [workspaceSkill()] } });

      const res = await app.request(`${baseUrl}/skill-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Skill deleted" });
      expect(fake.tables.skill).toEqual([]);
    });

    it("should 404 when deleting a shared skill not attached here", async () => {
      mockSession();
      const fake = world({ role: "admin", rows: { skill: [sharedSkill()] } });

      const res = await app.request(`${baseUrl}/org-skill-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
      expect(wrote(fake, "delete")).toBe(false);
    });

    it("should 403 (locked) when deleting an attached shared skill", async () => {
      mockSession();
      const fake = world({
        role: "admin",
        rows: {
          skill: [sharedSkill()],
          attachment: [attachedHere("org-skill-1")],
        },
      });

      const res = await app.request(`${baseUrl}/org-skill-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
      expect(wrote(fake, "delete")).toBe(false);
    });
  });
});
