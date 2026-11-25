import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
  type Store,
} from "../test-utils.ts";
import app from "../server.ts";

describe("Attachment Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/attachments`;
  const workspace = {
    id: workspaceId,
    ownerId: "owner-1",
    organizationId: orgId,
  };

  const uniqueAttachment = {
    name: "unique_attachment",
    columns: ["workspaceId", "resourceType", "resourceId"],
  };

  const attachmentRow = (over: Row = {}): Row => ({
    id: "att-1",
    workspaceId,
    resourceType: "mcp",
    resourceId: "mcp-1",
    ...over,
  });

  const world = (
    role: "admin" | "member" = "admin",
    rows: Store = {},
  ): FakeDb =>
    seedDb(
      {
        organization_member: [
          { id: "m1", userId: "user-1", organizationId: orgId, role },
        ],
        workspace: [workspace],
        mcp: [
          {
            id: "mcp-1",
            name: "MCP",
            slug: "mcp",
            authType: "None",
            organizationId: orgId,
            workspaceId: null,
          },
          {
            id: "mcp-ws",
            name: "Workspace MCP",
            slug: "workspace_mcp",
            authType: "None",
            organizationId: null,
            workspaceId,
          },
        ],
        skill: [
          {
            id: "skill-1",
            name: "Skill",
            description: "A skill",
            body: "Do things",
            organizationId: orgId,
            workspaceId: null,
          },
        ],
        provider: [
          {
            id: "p-x",
            name: "Elsewhere",
            organizationId: "org-2",
            workspaceId: null,
          },
        ],
        ...rows,
      },
      { unique: { attachment: [uniqueAttachment] } },
    );

  const post = (body: unknown) =>
    app.request(baseUrl, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

  describe("POST /", () => {
    it("attaches an org-scoped resource for an admin", async () => {
      mockSession();
      const fake = world();

      const res = await post({ resourceType: "mcp", resourceId: "mcp-1" });

      expect(res.status).toBe(201);
      const created = fake.tables.attachment.at(-1)!;
      expect(created).toMatchObject({
        workspaceId,
        resourceType: "mcp",
        resourceId: "mcp-1",
      });
      expect(await res.json()).toEqual(created);
    });

    it("attaches an org-scoped skill for an admin", async () => {
      mockSession();
      const fake = world();

      const res = await post({ resourceType: "skill", resourceId: "skill-1" });

      expect(res.status).toBe(201);
      const created = fake.tables.attachment.at(-1)!;
      expect(created).toMatchObject({
        workspaceId,
        resourceType: "skill",
        resourceId: "skill-1",
      });
      expect(await res.json()).toEqual(created);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      const fake = world("member");

      const res = await post({ resourceType: "mcp", resourceId: "mcp-1" });

      expect(res.status).toBe(403);
      expect(fake.queries.some((q) => q.kind === "insert")).toBe(false);
    });

    it("returns 404 when the resource is not org-scoped in this org", async () => {
      mockSession();
      const fake = world();

      const res = await post({ resourceType: "provider", resourceId: "p-x" });

      expect(res.status).toBe(404);
      expect(fake.queries.some((q) => q.kind === "insert")).toBe(false);
    });

    it("returns 409 when already attached", async () => {
      mockSession();
      const fake = world("admin", { attachment: [attachmentRow()] });

      const res = await post({ resourceType: "mcp", resourceId: "mcp-1" });

      expect(res.status).toBe(409);
      expect(fake.tables.attachment).toHaveLength(1);
    });
  });

  describe("DELETE /:resourceType/:resourceId", () => {
    const remove = (path = "mcp/mcp-1") =>
      app.request(`${baseUrl}/${path}`, { method: "DELETE" });

    it("detaches a resource for an admin", async () => {
      mockSession();
      const fake = world("admin", { attachment: [attachmentRow()] });

      const res = await remove();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Detached" });
      expect(fake.tables.attachment).toEqual([]);
    });

    it("returns 404 when no attachment exists", async () => {
      mockSession();
      world();

      const res = await remove();
      expect(res.status).toBe(404);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      const fake = world("member", { attachment: [attachmentRow()] });

      const res = await remove();
      expect(res.status).toBe(403);
      expect(fake.tables.attachment).toHaveLength(1);
    });
  });

  describe("GET /", () => {
    it("lists attachments for the workspace", async () => {
      mockSession();
      world("admin", {
        attachment: [
          attachmentRow(),
          attachmentRow({ id: "att-2", workspaceId: "ws-2" }),
        ],
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { results: unknown[] }).results).toEqual([
        attachmentRow(),
      ]);
    });
  });
});
