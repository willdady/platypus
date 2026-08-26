import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

import { createMcp, updateMcp, deleteMcp } from "./mcp-write.ts";
import type { McpCreateFields, McpUpdateFields } from "./mcp-write.ts";
import { ConflictError, LockedError, NotFoundError } from "../errors.ts";

const workspaceCtx = { orgId: "org-1", workspaceId: "ws-1" };

const createFields = (): McpCreateFields => ({
  name: "My MCP",
  url: "http://mcp.example.com",
  authType: "None",
});

const updateFields = (): McpUpdateFields => createFields();

describe("mcp write model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
  });

  describe("createMcp", () => {
    it("inserts a workspace-scoped MCP with a generated id and derived slug", async () => {
      mockDb.limit.mockResolvedValueOnce([]); // assertMcpSlugAvailable — no conflict
      const inserted = { id: "mcp-1", workspaceId: "ws-1" };
      mockDb.returning.mockResolvedValueOnce([inserted]);

      const row = await createMcp(
        { kind: "workspace", ctx: workspaceCtx },
        createFields(),
      );

      expect(row).toEqual(inserted);
      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.workspaceId).toBe("ws-1");
      expect(values.organizationId).toBeNull();
      expect(values.slug).toBe("my_mcp");
      expect(typeof values.id).toBe("string");
    });

    it("inserts an organization-scoped MCP with no workspace", async () => {
      mockDb.limit.mockResolvedValueOnce([]); // assertMcpSlugAvailable — no conflict
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

      await createMcp({ kind: "organization", orgId: "org-1" }, createFields());

      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.organizationId).toBe("org-1");
      expect(values.workspaceId).toBeNull();
    });

    it("throws ConflictError when the derived slug collides, before the insert", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "other-mcp", name: "My MCP" }]); // assertMcpSlugAvailable — conflict

      await expect(
        createMcp({ kind: "workspace", ctx: workspaceCtx }, createFields()),
      ).rejects.toThrow(ConflictError);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("updateMcp", () => {
    it("updates a workspace-scoped MCP after proving it mutable", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "mcp-1", workspaceId: "ws-1", url: "http://mcp.example.com" },
        ]) // requireWorkspaceMutable
        .mockResolvedValueOnce([]); // assertMcpSlugAvailable — no conflict
      const updated = { id: "mcp-1", workspaceId: "ws-1", name: "Renamed" };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const row = await updateMcp(
        { kind: "workspace", ctx: workspaceCtx },
        "mcp-1",
        { ...updateFields(), name: "Renamed" },
      );

      expect(row).toEqual(updated);
    });

    it("clears OAuth tokens and the OAuth client when the URL changes", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          {
            id: "mcp-1",
            workspaceId: "ws-1",
            url: "http://old.example.com",
          },
        ]) // requireWorkspaceMutable
        .mockResolvedValueOnce([]); // assertMcpSlugAvailable
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

      await updateMcp({ kind: "workspace", ctx: workspaceCtx }, "mcp-1", {
        ...updateFields(),
        url: "http://new.example.com",
      });

      const set = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(set).toMatchObject({
        oauthAccessToken: null,
        oauthRefreshToken: null,
        oauthTokenExpiresAt: null,
        oauthScope: null,
        oauthClientId: null,
        oauthClientSecret: null,
      });
    });

    it("leaves OAuth tokens untouched when the URL is unchanged", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          {
            id: "mcp-1",
            workspaceId: "ws-1",
            url: "http://mcp.example.com",
          },
        ])
        .mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

      await updateMcp({ kind: "workspace", ctx: workspaceCtx }, "mcp-1", {
        ...updateFields(),
        url: "http://mcp.example.com",
      });

      const set = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(set).not.toHaveProperty("oauthAccessToken");
      expect(set).not.toHaveProperty("oauthClientId");
    });

    it("throws NotFoundError for a workspace MCP not visible here, before the write", async () => {
      mockDb.limit.mockResolvedValueOnce([]); // resolveScoped: no row

      await expect(
        updateMcp(
          { kind: "workspace", ctx: workspaceCtx },
          "missing",
          updateFields(),
        ),
      ).rejects.toThrow(NotFoundError);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("throws LockedError for an attached Shared MCP on the workspace surface", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "mcp-1", organizationId: "org-1", workspaceId: null },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]); // attached

      await expect(
        updateMcp(
          { kind: "workspace", ctx: workspaceCtx },
          "mcp-1",
          updateFields(),
        ),
      ).rejects.toThrow(LockedError);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("updates an organization-scoped MCP after checking it is a Shared resource here", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          {
            id: "mcp-1",
            organizationId: "org-1",
            workspaceId: null,
            url: "http://mcp.example.com",
          },
        ]) // requireOrgScoped
        .mockResolvedValueOnce([]); // assertMcpSlugAvailable
      const updated = { id: "mcp-1", organizationId: "org-1" };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const row = await updateMcp(
        { kind: "organization", orgId: "org-1" },
        "mcp-1",
        updateFields(),
      );

      expect(row).toEqual(updated);
    });

    it("throws NotFoundError for an org MCP that is not Shared here, before the write", async () => {
      mockDb.limit.mockResolvedValueOnce([]); // requireOrgScoped: not found

      await expect(
        updateMcp(
          { kind: "organization", orgId: "org-1" },
          "missing",
          updateFields(),
        ),
      ).rejects.toThrow(NotFoundError);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("throws NotFoundError when a concurrently-deleted org MCP is gone by the write", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          {
            id: "mcp-1",
            organizationId: "org-1",
            workspaceId: null,
            url: "http://mcp.example.com",
          },
        ]) // requireOrgScoped
        .mockResolvedValueOnce([]); // assertMcpSlugAvailable
      mockDb.returning.mockResolvedValueOnce([]); // UPDATE matched nothing

      await expect(
        updateMcp(
          { kind: "organization", orgId: "org-1" },
          "mcp-1",
          updateFields(),
        ),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe("deleteMcp", () => {
    it("deletes a workspace-scoped MCP and scrubs its id from referencing Agents' toolSetIds (#689)", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "mcp-1", workspaceId: "ws-1" },
      ]); // requireWorkspaceMutable
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]); // delete

      await deleteMcp({ kind: "workspace", ctx: workspaceCtx }, "mcp-1");

      expect(mockDb.delete).toHaveBeenCalled();
      // The dead id is scrubbed from the same transaction's agent update — this
      // is the bug fix: workspace-scope delete never did this before.
      expect(mockDb.update).toHaveBeenCalled();
    });

    it("does not scrub when a concurrent delete already removed the row", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "mcp-1", workspaceId: "ws-1" },
      ]);
      mockDb.returning.mockResolvedValueOnce([]); // delete matched nothing

      await deleteMcp({ kind: "workspace", ctx: workspaceCtx }, "mcp-1");

      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("throws LockedError for an attached Shared MCP on the workspace surface, without deleting or scrubbing", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "mcp-1", organizationId: "org-1", workspaceId: null },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]); // attached

      await expect(
        deleteMcp({ kind: "workspace", ctx: workspaceCtx }, "mcp-1"),
      ).rejects.toThrow(LockedError);
      expect(mockDb.delete).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("deletes an org MCP once it is confirmed deletable, scrubbing dead references in the same transaction", async () => {
      mockDb.limit
        .mockResolvedValueOnce([]) // requireSharedDeletable: no attachment
        .mockResolvedValueOnce([]); // requireSharedDeletable: no blueprint
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

      await deleteMcp({ kind: "organization", orgId: "org-1" }, "mcp-1");

      expect(mockDb.delete).toHaveBeenCalled();
      expect(mockDb.update).toHaveBeenCalled();
    });

    it("throws ConflictError while an Attachment still references the org MCP", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "att-1" }]); // attached

      await expect(
        deleteMcp({ kind: "organization", orgId: "org-1" }, "mcp-1"),
      ).rejects.toThrow(ConflictError);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("throws ConflictError while a Blueprint still references the org MCP", async () => {
      mockDb.limit
        .mockResolvedValueOnce([]) // no attachment
        .mockResolvedValueOnce([{ id: "bpi-1" }]); // listed in a blueprint

      await expect(
        deleteMcp({ kind: "organization", orgId: "org-1" }, "mcp-1"),
      ).rejects.toThrow(ConflictError);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("throws NotFoundError when the org delete matches no row", async () => {
      mockDb.limit
        .mockResolvedValueOnce([]) // requireSharedDeletable: no attachment
        .mockResolvedValueOnce([]); // requireSharedDeletable: no blueprint
      mockDb.returning.mockResolvedValueOnce([]); // delete matched nothing

      await expect(
        deleteMcp({ kind: "organization", orgId: "org-1" }, "missing"),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
