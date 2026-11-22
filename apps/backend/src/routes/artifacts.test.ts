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

  describe("GET /:artifactId/versions", () => {
    it("lists every version newest first, without content", async () => {
      world();
      mockSession();

      const res = await app.request(`${baseUrl}/${artifactId}/versions`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: {
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
