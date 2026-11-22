import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ARTIFACT_CONTENT_MAX_BYTES } from "@platypus/schemas";
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

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The members, Workspaces and User every Artifact test runs against. */
  const baseWorld = (owner = "user-1") => ({
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
    user: [{ id: "user-1", name: "Ada", image: null }],
  });

  const world = (owner = "user-1") =>
    seedDb({
      ...baseWorld(owner),
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

  it("sends the approved script origins the viewer's frame needs", async () => {
    world();
    mockSession();
    vi.stubEnv(
      "ARTIFACT_SCRIPT_ORIGINS",
      "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    );

    const res = await app.request(`${baseUrl}/${artifactId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { scriptOrigins: string[] };
    expect(body.scriptOrigins).toEqual([
      "https://cdnjs.cloudflare.com",
      "https://cdn.jsdelivr.net",
    ]);
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

  describe("hand edit", () => {
    const handEditWorld = (owner = "user-1") =>
      seedDb({
        ...baseWorld(owner),
        artifact: [
          {
            id: artifactId,
            workspaceId,
            sourceChatId: null,
            title: "Plan",
            type: "markdown",
            language: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-02T00:00:00.000Z"),
          },
          {
            id: "script",
            workspaceId,
            sourceChatId: null,
            title: "Deploy script",
            type: "code",
            language: "bash",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
          {
            id: "artifact-2",
            workspaceId: "ws-2",
            sourceChatId: null,
            title: "Theirs",
            type: "markdown",
            language: null,
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
            author: "agent",
            createdAt: new Date("2026-01-02T00:00:00.000Z"),
          },
          {
            id: "v-script",
            artifactId: "script",
            version: 1,
            content: "echo hi",
            author: "agent",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ],
      });

    const save = (id: string, body: unknown) =>
      app.request(`${baseUrl}/${id}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    it("saves a hand edit as a new version the User wrote", async () => {
      handEditWorld();
      mockSession();

      const res = await save(artifactId, {
        content: "Second, with a typo fixed",
        baseVersion: 2,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        artifact: { title: string; updatedAt: string };
        version: { version: number; content: string; author: string };
        scriptOrigins: string[];
      };
      expect(body.artifact.title).toBe("Plan");
      expect(body.version).toMatchObject({
        version: 3,
        content: "Second, with a typo fixed",
        author: "user",
      });
      expect(body.scriptOrigins).toEqual(["https://cdnjs.cloudflare.com"]);
    });

    it("refuses a save based on a version that is no longer the latest", async () => {
      const fake = handEditWorld();
      mockSession();

      const res = await save(artifactId, {
        content: "Edited from a stale copy",
        baseVersion: 1,
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          "This Artifact changed while you were editing it. Reload to see the latest version.",
      });
      expect(fake.tables.artifact_version).toHaveLength(3);
    });

    it("refuses a hand edit to a non-markdown Artifact", async () => {
      const fake = handEditWorld();
      mockSession();

      const res = await save("script", {
        content: "echo bye",
        baseVersion: 1,
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Only markdown Artifacts can be hand-edited",
      });
      expect(fake.tables.artifact_version).toHaveLength(3);
    });

    it("refuses content over the limit", async () => {
      handEditWorld();
      mockSession();

      const res = await save(artifactId, {
        content: "x".repeat(ARTIFACT_CONTENT_MAX_BYTES + 1),
        baseVersion: 2,
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: Array<{ path: string[]; message: string }>;
      };
      expect(body.error).toContainEqual(
        expect.objectContaining({
          path: ["content"],
          message: "Artifact content must be at most 512 KB",
        }),
      );
    });

    it("refuses content that is not text", async () => {
      const fake = handEditWorld();
      mockSession();

      const res = await save(artifactId, {
        content: "before\u0000after",
        baseVersion: 2,
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Artifact content is not text",
      });
      expect(fake.tables.artifact_version).toHaveLength(3);
    });

    it("does not find an Artifact from another Workspace", async () => {
      handEditWorld();
      mockSession();

      const res = await save("artifact-2", {
        content: "Not mine",
        baseVersion: 1,
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Artifact not found" });
    });

    it("refuses a member who does not own the workspace", async () => {
      handEditWorld("other-user");
      mockSession();

      const res = await save(artifactId, {
        content: "Edited",
        baseVersion: 1,
      });

      expect(res.status).toBe(403);
    });

    it("requires authentication", async () => {
      handEditWorld();
      mockNoSession();

      const res = await save(artifactId, {
        content: "Edited",
        baseVersion: 2,
      });

      expect(res.status).toBe(401);
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

  describe("create from upload", () => {
    const uploadWorld = (owner = "user-1") =>
      seedDb({
        ...baseWorld(owner),
        artifact: [],
        artifact_version: [],
      });

    const uploadBody = (over: Record<string, unknown> = {}) => ({
      title: "Release notes",
      type: "markdown",
      content: "# 1.0\n",
      ...over,
    });

    const post = (body: unknown) =>
      app.request(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    it("writes version 1 as the User, with no source Chat", async () => {
      const fake = uploadWorld();
      mockSession();

      const res = await post(uploadBody());

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string;
        title: string;
        type: string;
        sourceChatId: string | null;
      };
      expect(body).toMatchObject({
        title: "Release notes",
        type: "markdown",
        sourceChatId: null,
      });

      expect(fake.tables.artifact).toEqual([
        expect.objectContaining({
          id: body.id,
          workspaceId,
          sourceChatId: null,
          title: "Release notes",
          type: "markdown",
          language: null,
        }),
      ]);
      expect(fake.tables.artifact_version).toEqual([
        expect.objectContaining({
          artifactId: body.id,
          version: 1,
          content: "# 1.0\n",
          author: "user",
        }),
      ]);
    });

    it("stores a code Artifact's language from the upload", async () => {
      const fake = uploadWorld();
      mockSession();

      const res = await post(
        uploadBody({ title: "build", type: "code", language: "py" }),
      );

      expect(res.status).toBe(201);
      expect(fake.tables.artifact[0].language).toBe("py");
    });

    it("refuses content over the limit, storing nothing", async () => {
      const fake = uploadWorld();
      mockSession();

      const res = await post(
        uploadBody({ content: "x".repeat(ARTIFACT_CONTENT_MAX_BYTES + 1) }),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: Array<{ path: string[]; message: string }>;
      };
      expect(body.error).toContainEqual(
        expect.objectContaining({ path: ["content"] }),
      );
      expect(fake.tables.artifact).toEqual([]);
      expect(fake.tables.artifact_version).toEqual([]);
    });

    it("accepts content exactly at the cap", async () => {
      uploadWorld();
      mockSession();

      const res = await post(
        uploadBody({ content: "x".repeat(ARTIFACT_CONTENT_MAX_BYTES) }),
      );

      expect(res.status).toBe(201);
    });

    it("refuses content that is not text, storing nothing", async () => {
      const fake = uploadWorld();
      mockSession();

      const res = await post(uploadBody({ content: "before\u0000after" }));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Artifact content is not text",
      });
      expect(fake.tables.artifact).toEqual([]);
      expect(fake.tables.artifact_version).toEqual([]);
    });

    it("keeps a replacement character, which is ordinary text", async () => {
      const fake = uploadWorld();
      mockSession();

      const res = await post(uploadBody({ content: "before\uFFFDafter" }));

      expect(res.status).toBe(201);
      expect(fake.tables.artifact_version).toEqual([
        expect.objectContaining({
          content: "before\uFFFDafter",
          author: "user",
        }),
      ]);
    });

    it("refuses a member who does not own the workspace", async () => {
      uploadWorld("other-user");
      mockSession();

      const res = await post(uploadBody());

      expect(res.status).toBe(403);
    });

    it("returns 401 when not authenticated", async () => {
      uploadWorld();
      mockNoSession();

      const res = await post(uploadBody());

      expect(res.status).toBe(401);
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
