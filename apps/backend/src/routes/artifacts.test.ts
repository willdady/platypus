import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockSession,
  mockNoSession,
  resetMockDb,
  seedDb,
} from "../test-utils.ts";
import app from "../server.ts";

const orgId = "org-1";
const workspaceId = "ws-1";
const artifactId = "artifact-1";
const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/artifacts`;

describe("Artifact Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const world = (owner = "user-1") =>
    seedDb({
      organization_member: [
        { id: "m1", userId: "user-1", organizationId: orgId, role: "member" },
      ],
      workspace: [
        { id: workspaceId, organizationId: orgId, ownerId: owner },
        { id: "ws-2", organizationId: orgId, ownerId: "other-user" },
      ],
      chat: [
        { id: "chat-1", workspaceId, title: "Source", status: "succeeded" },
        {
          id: "chat-2",
          workspaceId: "ws-2",
          title: "Theirs",
          status: "succeeded",
        },
      ],
      artifact: [
        {
          id: artifactId,
          workspaceId,
          sourceChatId: "chat-1",
          title: "Plan",
          type: "markdown",
          language: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        },
        {
          id: "artifact-2",
          workspaceId: "ws-2",
          sourceChatId: "chat-2",
          title: "Theirs",
          type: "code",
          language: "ts",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      artifact_version: [
        {
          id: "v1",
          artifactId,
          version: 1,
          content: "First",
          author: "agent",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          id: "v2",
          artifactId,
          version: 2,
          content: "Second",
          author: "user",
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        },
        {
          id: "v-theirs",
          artifactId: "artifact-2",
          version: 1,
          content: "Theirs",
          author: "agent",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      user: [{ id: "user-1", name: "Ada", image: null }],
    });

  it("returns 401 when not authenticated", async () => {
    mockNoSession();
    const res = await app.request(`${baseUrl}/${artifactId}`);
    expect(res.status).toBe(401);
  });

  it("returns 403 to a member who does not own the workspace", async () => {
    world("other-user");
    mockSession();

    const res = await app.request(`${baseUrl}/${artifactId}`);

    expect(res.status).toBe(403);
  });

  it("reads the latest version with its Artifact", async () => {
    world();
    mockSession();

    const res = await app.request(`${baseUrl}/${artifactId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifact: { id: string; title: string; type: string };
      version: { version: number; content: string; author: string };
    };
    expect(body.artifact).toMatchObject({
      id: artifactId,
      title: "Plan",
      type: "markdown",
    });
    expect(body.version).toMatchObject({
      version: 2,
      content: "Second",
      author: "user",
    });
  });

  it("reads a named version", async () => {
    world();
    mockSession();

    const res = await app.request(`${baseUrl}/${artifactId}?version=1`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: { version: number; content: string };
    };
    expect(body.version).toMatchObject({ version: 1, content: "First" });
  });

  it("does not find an Artifact from another Workspace", async () => {
    world();
    mockSession();

    const res = await app.request(`${baseUrl}/artifact-2`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Artifact not found" });
  });

  it("does not find a version that does not exist", async () => {
    world();
    mockSession();

    const res = await app.request(`${baseUrl}/${artifactId}?version=9`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Artifact version not found" });
  });

  it("rejects a malformed version", async () => {
    world();
    mockSession();

    const res = await app.request(`${baseUrl}/${artifactId}?version=latest`);

    expect(res.status).toBe(400);
  });

  describe("list", () => {
    const listWorld = () =>
      seedDb({
        organization_member: [
          {
            id: "m1",
            userId: "user-1",
            organizationId: orgId,
            role: "member",
          },
        ],
        workspace: [
          { id: workspaceId, organizationId: orgId, ownerId: "user-1" },
          { id: "ws-2", organizationId: orgId, ownerId: "other-user" },
        ],
        user: [{ id: "user-1", name: "Ada", image: null }],
        artifact: [
          {
            id: "older-plan",
            workspaceId,
            sourceChatId: null,
            title: "Old plan",
            type: "markdown",
            language: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
          {
            id: "script",
            workspaceId,
            sourceChatId: null,
            title: "Deploy script",
            type: "code",
            language: "bash",
            createdAt: new Date("2026-01-02T00:00:00.000Z"),
            updatedAt: new Date("2026-01-03T00:00:00.000Z"),
          },
          {
            id: "new-plan",
            workspaceId,
            sourceChatId: null,
            title: "New plan",
            type: "markdown",
            language: null,
            createdAt: new Date("2026-01-04T00:00:00.000Z"),
            updatedAt: new Date("2026-01-05T00:00:00.000Z"),
          },
          {
            id: "theirs",
            workspaceId: "ws-2",
            sourceChatId: null,
            title: "Theirs",
            type: "markdown",
            language: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ],
      });

    it("lists a Workspace's Artifacts, most recently updated first", async () => {
      listWorld();
      mockSession();

      const res = await app.request(baseUrl);

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ id: string }>;
        totalCount: number;
      };
      expect(body.results.map((row) => row.id)).toEqual([
        "new-plan",
        "script",
        "older-plan",
      ]);
      expect(body.totalCount).toBe(3);
    });

    it("pages server-side", async () => {
      listWorld();
      mockSession();

      const res = await app.request(`${baseUrl}?limit=1&offset=1`);

      const body = (await res.json()) as {
        results: Array<{ id: string }>;
        totalCount: number;
      };
      expect(body.results.map((row) => row.id)).toEqual(["script"]);
      expect(body.totalCount).toBe(3);
    });

    it("searches titles, ignoring case", async () => {
      listWorld();
      mockSession();

      const res = await app.request(`${baseUrl}?search=PLAN`);

      const body = (await res.json()) as {
        results: Array<{ id: string }>;
        totalCount: number;
      };
      expect(body.results.map((row) => row.id)).toEqual([
        "new-plan",
        "older-plan",
      ]);
      expect(body.totalCount).toBe(2);
    });

    it("filters by type", async () => {
      listWorld();
      mockSession();

      const res = await app.request(`${baseUrl}?type=code`);

      const body = (await res.json()) as {
        results: Array<{ id: string }>;
        totalCount: number;
      };
      expect(body.results.map((row) => row.id)).toEqual(["script"]);
      expect(body.totalCount).toBe(1);
    });

    it("breaks a last-updated tie by id, so paging stays stable", async () => {
      const sameTime = new Date("2026-02-01T00:00:00.000Z");
      seedDb({
        organization_member: [
          {
            id: "m1",
            userId: "user-1",
            organizationId: orgId,
            role: "member",
          },
        ],
        workspace: [
          { id: workspaceId, organizationId: orgId, ownerId: "user-1" },
        ],
        user: [{ id: "user-1", name: "Ada", image: null }],
        artifact: ["tie-a", "tie-b"].map((id) => ({
          id,
          workspaceId,
          sourceChatId: null,
          title: id,
          type: "markdown",
          language: null,
          createdAt: sameTime,
          updatedAt: sameTime,
        })),
      });
      mockSession();

      const res = await app.request(baseUrl);

      const body = (await res.json()) as { results: Array<{ id: string }> };
      expect(body.results.map((row) => row.id)).toEqual(["tie-b", "tie-a"]);
    });

    it("rejects a type the domain does not have", async () => {
      listWorld();
      mockSession();

      const res = await app.request(`${baseUrl}?type=spreadsheet`);

      expect(res.status).toBe(400);
    });
  });

  describe("rename", () => {
    it("renames an Artifact", async () => {
      world();
      mockSession();

      const res = await app.request(`${baseUrl}/${artifactId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Renamed" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { title: string };
      expect(body.title).toBe("Renamed");
    });

    it("refuses a title over the limit, naming the rule", async () => {
      world();
      mockSession();

      const res = await app.request(`${baseUrl}/${artifactId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x".repeat(201) }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: Array<{ path: string[]; message: string }>;
      };
      expect(body.error).toContainEqual(
        expect.objectContaining({ path: ["title"] }),
      );
    });

    it("does not find an Artifact from another Workspace", async () => {
      world();
      mockSession();

      const res = await app.request(`${baseUrl}/artifact-2`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Renamed" }),
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Artifact not found" });
    });

    it("refuses a member who does not own the workspace", async () => {
      world("other-user");
      mockSession();

      const res = await app.request(`${baseUrl}/${artifactId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Renamed" }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe("delete", () => {
    it("deletes the Artifact and every version it holds", async () => {
      const fake = world();
      mockSession();

      const res = await app.request(`${baseUrl}/${artifactId}`, {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Artifact deleted" });
      expect(fake.tables.artifact.map((row) => row.id)).toEqual(["artifact-2"]);
      expect(fake.tables.artifact_version.map((row) => row.id)).toEqual([
        "v-theirs",
      ]);
    });

    it("does not find an Artifact from another Workspace", async () => {
      const fake = world();
      mockSession();

      const res = await app.request(`${baseUrl}/artifact-2`, {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
      expect(fake.tables.artifact).toHaveLength(2);
    });

    it("refuses a member who does not own the workspace", async () => {
      world("other-user");
      mockSession();

      const res = await app.request(`${baseUrl}/${artifactId}`, {
        method: "DELETE",
      });

      expect(res.status).toBe(403);
    });
  });

  describe("GET /:artifactId/versions", () => {
    it("lists every version newest first, without content", async () => {
      world();
      mockSession();

      const res = await app.request(`${baseUrl}/${artifactId}/versions`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: {
          artifactId: string;
          version: number;
          author: string;
          createdAt: string;
          content?: string;
        }[];
      };
      expect(body.results).toHaveLength(2);
      expect(body.results.map(({ version }) => version)).toEqual([2, 1]);
      expect(body.results[0]).toMatchObject({
        artifactId,
        version: 2,
        author: "user",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      expect(body.results[0]).not.toHaveProperty("content");
    });

    it("requires authentication and Workspace access", async () => {
      world();
      mockNoSession();
      expect(
        (await app.request(`${baseUrl}/${artifactId}/versions`)).status,
      ).toBe(401);

      world("other-user");
      mockSession();
      expect(
        (await app.request(`${baseUrl}/${artifactId}/versions`)).status,
      ).toBe(403);
    });

    it("does not find another Workspace's Artifact", async () => {
      world();
      mockSession();

      const res = await app.request(`${baseUrl}/artifact-2/versions`);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Artifact not found" });
    });
  });
});
