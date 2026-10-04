import { describe, it, expect, beforeEach, vi } from "vitest";
import { seedDb, mockSession, resetMockDb, type Store } from "../test-utils.ts";
import app from "../server.ts";

/**
 * These tests state fixture rows rather than counting queries: `seedDb()`
 * installs the in-memory fake executor from `fake-db.ts`, which interprets the
 * `WHERE` each query builds. A route that matched an Attachment on its
 * `resourceId` alone, or an "org-scoped" resource on its `organizationId`
 * alone, reads a row it should not see here and the test fails — where the
 * chainable mock would have handed back whichever rows the test stubbed next.
 */
describe("Organization Attachment (central sharing) Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/attachments`;
  const createdAt = new Date("2026-01-01T00:00:00.000Z");

  /** Membership rows: the caller is an admin of `org-1` unless stated otherwise. */
  const membership = (role: "admin" | "member") => [
    { id: "m1", userId: "user-1", organizationId: orgId, role },
  ];

  /** The baseline org: two of its workspaces, plus one belonging to another org. */
  const workspaces = [
    { id: "ws-1", name: "Alpha", organizationId: orgId },
    { id: "ws-2", name: "Beta", organizationId: orgId },
    { id: "ws-elsewhere", name: "Gamma", organizationId: "org-2" },
  ];

  /** A Shared Agent of this org — org-scoped, at no workspace (ADR-0007). */
  const sharedAgent = {
    id: "agent-1",
    name: "Shared Agent",
    organizationId: orgId,
    workspaceId: null,
  };

  const seed = (rows: Store) =>
    seedDb(rows, {
      unique: {
        attachment: [
          {
            name: "unique_attachment",
            columns: ["workspaceId", "resourceType", "resourceId"],
          },
        ],
      },
    });

  describe("GET /", () => {
    it("lists the workspaces a shared resource is attached to", async () => {
      mockSession();
      seed({
        organization_member: membership("admin"),
        workspace: workspaces,
        attachment: [
          {
            id: "att-1",
            workspaceId: "ws-1",
            resourceType: "agent",
            resourceId: "agent-1",
            createdAt,
          },
          {
            id: "att-2",
            workspaceId: "ws-2",
            resourceType: "agent",
            resourceId: "agent-1",
            createdAt,
          },
        ],
      });

      const res = await app.request(
        `${baseUrl}?resourceType=agent&resourceId=agent-1`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: { workspaceId: string; workspaceName: string }[];
      };
      expect(body.results).toEqual([
        expect.objectContaining({
          workspaceId: "ws-1",
          workspaceName: "Alpha",
        }),
        expect.objectContaining({ workspaceId: "ws-2", workspaceName: "Beta" }),
      ]);
    });

    it("lists neither another resource's attachments nor another org's", async () => {
      // The list joins through workspace and filters on all three columns. A
      // query keyed on `resourceId` alone would return the MCP row; one that
      // dropped the organization check would return the foreign workspace.
      mockSession();
      seed({
        organization_member: membership("admin"),
        workspace: workspaces,
        attachment: [
          {
            id: "att-1",
            workspaceId: "ws-1",
            resourceType: "agent",
            resourceId: "agent-1",
            createdAt,
          },
          {
            id: "att-2",
            workspaceId: "ws-1",
            resourceType: "mcp",
            resourceId: "agent-1",
            createdAt,
          },
          {
            id: "att-3",
            workspaceId: "ws-elsewhere",
            resourceType: "agent",
            resourceId: "agent-1",
            createdAt,
          },
        ],
      });

      const res = await app.request(
        `${baseUrl}?resourceType=agent&resourceId=agent-1`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { workspaceId: string }[] };
      expect(body.results).toEqual([
        expect.objectContaining({ workspaceId: "ws-1" }),
      ]);
    });

    it("returns 400 without resourceType/resourceId", async () => {
      mockSession();
      seed({ organization_member: membership("admin") });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(400);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      seed({ organization_member: membership("member") });

      const res = await app.request(
        `${baseUrl}?resourceType=agent&resourceId=agent-1`,
      );
      expect(res.status).toBe(403);
    });
  });

  describe("POST /", () => {
    const body = {
      resourceType: "agent",
      resourceId: "agent-1",
      workspaceId: "ws-1",
    };

    const post = (payload: unknown = body) =>
      app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      });

    it("attaches a shared resource to a workspace", async () => {
      mockSession();
      const fake = seed({
        organization_member: membership("admin"),
        workspace: workspaces,
        agent: [sharedAgent],
        attachment: [],
      });

      const res = await post();
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(
        expect.objectContaining({
          workspaceId: "ws-1",
          resourceType: "agent",
          resourceId: "agent-1",
        }),
      );
      expect(fake.tables.attachment).toHaveLength(1);
    });

    it("404s a resource that carries a workspace as well as this org", async () => {
      // Sharing is managed only for a genuinely Shared resource: the lookup
      // requires no Workspace, so a row carrying both scope columns cannot be
      // attached elsewhere on the strength of its org column (ADR-0007).
      // Drop `isNull(agent.workspaceId)` from `sharedWhere` and this passes.
      mockSession();
      const fake = seed({
        organization_member: membership("admin"),
        workspace: workspaces,
        agent: [{ ...sharedAgent, workspaceId: "ws-2" }],
        attachment: [],
      });

      const res = await post();
      expect(res.status).toBe(404);
      expect(fake.tables.attachment).toHaveLength(0);
    });

    it("404s a Shared resource of another organization", async () => {
      mockSession();
      seed({
        organization_member: membership("admin"),
        workspace: workspaces,
        agent: [{ ...sharedAgent, organizationId: "org-2" }],
      });

      const res = await post();
      expect(res.status).toBe(404);
    });

    it("404s when the workspace is not in this org", async () => {
      mockSession();
      seed({
        organization_member: membership("admin"),
        workspace: workspaces,
        agent: [sharedAgent],
      });

      const res = await post({ ...body, workspaceId: "ws-elsewhere" });
      expect(res.status).toBe(404);
    });

    it("409s when the resource is already attached to that workspace", async () => {
      mockSession();
      seed({
        organization_member: membership("admin"),
        workspace: workspaces,
        agent: [sharedAgent],
        attachment: [
          {
            id: "att-1",
            workspaceId: "ws-1",
            resourceType: "agent",
            resourceId: "agent-1",
            createdAt,
          },
        ],
      });

      const res = await post();
      expect(res.status).toBe(409);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      seed({ organization_member: membership("member") });

      const res = await post();
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /:resourceType/:resourceId/:workspaceId", () => {
    const delUrl = `${baseUrl}/agent/agent-1/ws-1`;

    const attachments = [
      {
        id: "att-1",
        workspaceId: "ws-1",
        resourceType: "agent",
        resourceId: "agent-1",
        createdAt,
      },
      {
        id: "att-2",
        workspaceId: "ws-2",
        resourceType: "agent",
        resourceId: "agent-1",
        createdAt,
      },
    ];

    it("detaches a shared resource from one workspace only", async () => {
      mockSession();
      const fake = seed({
        organization_member: membership("admin"),
        workspace: workspaces,
        attachment: attachments,
      });

      const res = await app.request(delUrl, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Detached" });
      // The other workspace's Attachment survives — a delete keyed on
      // `resourceId` alone would have taken it too.
      expect(fake.tables.attachment).toEqual([
        expect.objectContaining({ id: "att-2" }),
      ]);
    });

    it("deletes the Workspace's A2A endpoints for a detached Shared Agent", async () => {
      mockSession();
      const endpoint = (id: string, workspaceId: string, agentId: string) => ({
        id,
        workspaceId,
        agentId,
        name: "Public",
        description: "Public",
        enabled: true,
      });
      const fake = seed({
        organization_member: membership("admin"),
        workspace: workspaces,
        attachment: attachments,
        a2a_endpoint: [
          endpoint("ep-detached", "ws-1", "agent-1"),
          endpoint("ep-other-agent", "ws-1", "agent-2"),
          endpoint("ep-other-workspace", "ws-2", "agent-1"),
        ],
      });

      const res = await app.request(delUrl, { method: "DELETE" });

      expect(res.status).toBe(200);
      expect(fake.tables.a2a_endpoint.map((e) => e.id)).toEqual([
        "ep-other-agent",
        "ep-other-workspace",
      ]);
    });

    it("404s when no such attachment exists", async () => {
      mockSession();
      seed({
        organization_member: membership("admin"),
        workspace: workspaces,
        attachment: [attachments[1]],
      });

      const res = await app.request(delUrl, { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("404s when the workspace is not in this org", async () => {
      mockSession();
      const fake = seed({
        organization_member: membership("admin"),
        workspace: workspaces,
        attachment: [
          {
            id: "att-3",
            workspaceId: "ws-elsewhere",
            resourceType: "agent",
            resourceId: "agent-1",
            createdAt,
          },
        ],
      });

      const res = await app.request(`${baseUrl}/agent/agent-1/ws-elsewhere`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
      expect(fake.tables.attachment).toHaveLength(1);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      seed({ organization_member: membership("member") });

      const res = await app.request(delUrl, { method: "DELETE" });
      expect(res.status).toBe(403);
    });
  });
});
