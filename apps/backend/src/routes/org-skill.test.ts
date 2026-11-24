import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
  type Store,
} from "../test-utils.ts";
import type { FakeDbOptions } from "../fake-db.ts";
import app from "../server.ts";

vi.mock("../services/skill-bundle.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/skill-bundle.ts")>()),
  rehashSkill: vi.fn((_db: unknown, row: unknown) => Promise.resolve(row)),
  listSkillFiles: vi.fn(() => Promise.resolve([])),
  skillFilesForApi: vi.fn(() => Promise.resolve([])),
}));

describe("Organization Skill Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/skills`;

  const createBody = {
    name: "org-skill",
    description: "This is a long enough description for the skill.",
    body: "This is a long enough body for the skill to pass the validation requirements.",
  };

  const orgSkill = (over: Row = {}): Row => ({
    id: "skill-1",
    organizationId: orgId,
    workspaceId: null,
    name: "org-skill",
    description: createBody.description,
    body: createBody.body,
    frontmatter: {},
    bundleHash: null,
    installedHash: null,
    ...over,
  });

  const attachedTo = (workspaceId: string, resourceId: string): Row => ({
    id: `att-${resourceId}`,
    workspaceId,
    resourceType: "skill",
    resourceId,
  });

  const listedIn = (blueprintId: string, resourceId: string): Row => ({
    id: `bpi-${resourceId}`,
    blueprintId,
    resourceType: "skill",
    resourceId,
  });

  const uniqueNameOrg = {
    name: "unique_skill_name_org",
    columns: ["organizationId", "name"],
    where: (row: Row) => row.organizationId != null,
  };

  const world = ({
    role = "admin",
    rows = {},
    db,
  }: {
    role?: "admin" | "member";
    rows?: Store;
    db?: FakeDbOptions;
  } = {}): FakeDb =>
    seedDb(
      {
        organization_member: [
          { id: "m1", userId: "user-1", organizationId: orgId, role },
        ],
        ...rows,
      },
      db,
    );

  const send = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    body?: unknown,
  ) =>
    app.request(url, {
      method,
      ...(body !== undefined && {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
    });

  const wrote = (fake: FakeDb, kind: "insert" | "update" | "delete") =>
    fake.queries.some((query) => query.kind === kind);

  describe("POST /", () => {
    it("creates an org skill if org admin", async () => {
      mockSession();
      const fake = world();

      const res = await send("POST", baseUrl, createBody);

      expect(res.status).toBe(201);
      const created = fake.tables.skill.at(-1);
      expect(await res.json()).toEqual({ ...created, scope: "organization" });
      expect(created).toMatchObject({
        name: "org-skill",
        description: createBody.description,
        body: createBody.body,
        organizationId: orgId,
        workspaceId: null,
      });
    });

    it("returns 403 if not org admin", async () => {
      mockSession();
      const fake = world({ role: "member" });

      const res = await send("POST", baseUrl, createBody);

      expect(res.status).toBe(403);
      expect(wrote(fake, "insert")).toBe(false);
    });

    it("returns 409 if a skill name already exists in the org", async () => {
      mockSession();
      const fake = world({
        rows: { skill: [orgSkill()] },
        db: { unique: { skill: [uniqueNameOrg] } },
      });

      const res = await send("POST", baseUrl, createBody);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "A resource with that name already exists",
      });
      expect(fake.tables.skill).toHaveLength(1);
    });
  });

  describe("GET /", () => {
    it("lists org skills for any member", async () => {
      mockSession();
      world({
        role: "member",
        rows: {
          skill: [
            orgSkill({ id: "skill-1", name: "org-skill" }),
            orgSkill({
              id: "skill-other-org",
              name: "org-skill",
              organizationId: "org-2",
            }),
            orgSkill({
              id: "skill-workspace",
              name: "org-skill",
              organizationId: null,
              workspaceId: "ws-1",
            }),
          ],
        },
      });

      const res = await send("GET", baseUrl);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { results: Row[] };
      expect(
        json.results.map(({ id, name, scope }) => ({ id, name, scope })),
      ).toEqual([{ id: "skill-1", name: "org-skill", scope: "organization" }]);
    });
  });

  describe("GET /:skillId", () => {
    it("returns an org skill", async () => {
      mockSession();
      world({
        role: "member",
        rows: {
          skill: [
            orgSkill({ id: "skill-1", organizationId: "org-2" }),
            orgSkill({ id: "skill-1", name: "org-skill" }),
          ],
        },
      });

      const res = await send("GET", `${baseUrl}/skill-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: "skill-1",
        name: "org-skill",
        organizationId: orgId,
        scope: "organization",
        files: [],
        modified: false,
      });
    });

    it("returns 404 if not found", async () => {
      mockSession();
      world({
        role: "member",
        rows: {
          skill: [orgSkill({ id: "missing", organizationId: "org-2" })],
        },
      });

      const res = await send("GET", `${baseUrl}/missing`);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:skillId", () => {
    it("updates an org skill if org admin", async () => {
      mockSession();
      const fake = world({
        rows: { skill: [orgSkill({ id: "skill-1", name: "before-skill" })] },
      });

      const res = await send("PUT", `${baseUrl}/skill-1`, {
        name: "org-skill",
        description: "This is a long enough description for the skill.",
        body: "This is a long enough body for the skill to pass the validation requirements.",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: "skill-1",
        name: "org-skill",
        organizationId: orgId,
        scope: "organization",
      });
      expect(fake.tables.skill[0]).toMatchObject({
        id: "skill-1",
        name: "org-skill",
      });
    });

    it("404s a skill that is not a Shared resource of this org, without touching the write", async () => {
      mockSession();
      const fake = world({
        rows: {
          skill: [
            orgSkill({ id: "missing", organizationId: "org-2" }),
            orgSkill({
              id: "missing",
              organizationId: null,
              workspaceId: "ws-1",
            }),
          ],
        },
      });

      const res = await send("PUT", `${baseUrl}/missing`, {
        name: "org-skill",
        description: "This is a long enough description for the skill.",
        body: "This is a long enough body for the skill to pass the validation requirements.",
      });

      expect(res.status).toBe(404);
      expect(wrote(fake, "update")).toBe(false);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      world({ role: "member", rows: { skill: [orgSkill()] } });

      const res = await send("PUT", `${baseUrl}/skill-1`, {
        name: "org-skill",
        description: "This is a long enough description for the skill.",
        body: "This is a long enough body for the skill to pass the validation requirements.",
      });

      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /:skillId", () => {
    it("deletes an org skill if org admin and not attached", async () => {
      mockSession();
      const fake = world({
        rows: {
          skill: [orgSkill({ id: "skill-1" })],
          agent: [
            {
              id: "agent-1",
              workspaceId: "ws-1",
              skillIds: ["skill-1", "skill-2"],
            },
          ],
        },
      });

      const res = await send("DELETE", `${baseUrl}/skill-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Skill deleted" });
      expect(fake.tables.skill).toEqual([]);
      expect(fake.tables.agent[0].skillIds).toEqual(["skill-2"]);
      expect(wrote(fake, "update")).toBe(true);
    });

    it("returns 409 when the skill is attached to a workspace", async () => {
      mockSession();
      const fake = world({
        rows: {
          skill: [orgSkill({ id: "skill-1" })],
          attachment: [attachedTo("ws-1", "skill-1")],
        },
      });

      const res = await send("DELETE", `${baseUrl}/skill-1`);
      expect(res.status).toBe(409);
      expect(fake.tables.skill).toHaveLength(1);
    });

    it("returns 409 when the skill is listed in a blueprint", async () => {
      mockSession();
      const fake = world({
        rows: {
          skill: [orgSkill({ id: "skill-1" })],
          blueprint_item: [listedIn("bp-1", "skill-1")],
        },
      });

      const res = await send("DELETE", `${baseUrl}/skill-1`);
      expect(res.status).toBe(409);
      expect(fake.tables.skill).toHaveLength(1);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      const fake = world({ role: "member", rows: { skill: [orgSkill()] } });

      const res = await send("DELETE", `${baseUrl}/skill-1`);
      expect(res.status).toBe(403);
      expect(fake.tables.skill).toHaveLength(1);
    });
  });
});
