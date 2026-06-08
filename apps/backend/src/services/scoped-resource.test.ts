import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import {
  resolveScoped,
  listScoped,
  requireScoped,
  requireWorkspaceMutable,
  requireSharedDeletable,
} from "./scoped-resource.ts";
import { NotFoundError, LockedError, ConflictError } from "../errors.ts";

const ctx = { orgId: "org-1", wsId: "ws-1" };

describe("ScopedResource read module", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  describe("resolveScoped", () => {
    it("returns a workspace-scoped row tagged scope workspace", async () => {
      const row = {
        id: "a1",
        name: "WS Agent",
        workspaceId: "ws-1",
        organizationId: null,
      };
      mockDb.limit.mockResolvedValueOnce([row]);

      const found = await resolveScoped(mockDb, "agent", "a1", ctx);
      expect(found).toEqual({ row, scope: "workspace" });
    });

    it("returns an attached org-scoped row tagged scope organization", async () => {
      const row = {
        id: "a1",
        name: "Shared",
        organizationId: "org-1",
        workspaceId: null,
      };
      mockDb.limit
        .mockResolvedValueOnce([row]) // resource lookup → org-scoped
        .mockResolvedValueOnce([{ id: "att-1" }]); // attachment check → attached

      const found = await resolveScoped(mockDb, "agent", "a1", ctx);
      expect(found).toEqual({ row, scope: "organization" });
    });

    it("returns null for an org-scoped row not attached here", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "a1", organizationId: "org-1", workspaceId: null },
        ])
        .mockResolvedValueOnce([]); // attachment check → not attached

      const found = await resolveScoped(mockDb, "agent", "a1", ctx);
      expect(found).toBeNull();
    });

    it("returns null when the resource is missing", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const found = await resolveScoped(mockDb, "agent", "a1", ctx);
      expect(found).toBeNull();
    });
  });

  describe("listScoped", () => {
    it("unions workspace rows with attached org rows", async () => {
      const wsRow = { id: "ws-a", workspaceId: "ws-1" };
      const orgRow = { id: "org-a", organizationId: "org-1" };
      mockDb.where
        .mockResolvedValueOnce([wsRow]) // workspace-scoped query
        // attached org rows arrive from an inner join, keyed by table name.
        .mockResolvedValueOnce([{ agent: orgRow }]);

      const results = await listScoped(mockDb, "agent", ctx);
      expect(results).toEqual([
        { row: wsRow, scope: "workspace" },
        { row: orgRow, scope: "organization" },
      ]);
    });
  });

  describe("requireScoped", () => {
    it("throws NotFoundError when not visible here", async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      await expect(
        requireScoped(mockDb, "agent", "a1", ctx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("returns the resolved row when visible", async () => {
      const row = { id: "a1", workspaceId: "ws-1", organizationId: null };
      mockDb.limit.mockResolvedValueOnce([row]);
      const found = await requireScoped(mockDb, "agent", "a1", ctx);
      expect(found).toEqual({ row, scope: "workspace" });
    });
  });

  describe("requireWorkspaceMutable", () => {
    it("returns a workspace row unchanged", async () => {
      const row = { id: "a1", workspaceId: "ws-1", organizationId: null };
      mockDb.limit.mockResolvedValueOnce([row]);
      const found = await requireWorkspaceMutable(mockDb, "agent", "a1", ctx);
      expect(found).toEqual({ row, scope: "workspace" });
    });

    it("throws LockedError for an attached org-scoped row", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "a1", organizationId: "org-1", workspaceId: null },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]); // attached → visible but locked
      await expect(
        requireWorkspaceMutable(mockDb, "agent", "a1", ctx),
      ).rejects.toBeInstanceOf(LockedError);
    });

    it("throws NotFoundError (not Locked) when missing", async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      await expect(
        requireWorkspaceMutable(mockDb, "agent", "a1", ctx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("requireSharedDeletable", () => {
    it("throws ConflictError while an Attachment references it", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "att-1" }]); // attachment lookup
      await expect(
        requireSharedDeletable(mockDb, "agent", "a1"),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("throws ConflictError while a Blueprint lists it", async () => {
      mockDb.limit
        .mockResolvedValueOnce([]) // attachment lookup → none
        .mockResolvedValueOnce([{ id: "item-1" }]); // blueprint lookup → listed
      await expect(
        requireSharedDeletable(mockDb, "agent", "a1"),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("resolves when nothing points at it", async () => {
      mockDb.limit
        .mockResolvedValueOnce([]) // attachment lookup → none
        .mockResolvedValueOnce([]); // blueprint lookup → none
      await expect(
        requireSharedDeletable(mockDb, "agent", "a1"),
      ).resolves.toBeUndefined();
    });

    it("uses the uppercase MCP acronym in the conflict message", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "att-1" }]);
      await expect(requireSharedDeletable(mockDb, "mcp", "m1")).rejects.toThrow(
        /this MCP is attached/,
      );
    });
  });
});
