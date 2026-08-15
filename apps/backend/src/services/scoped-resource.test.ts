import { describe, it, expect, beforeEach, vi } from "vitest";
// test-utils installs the drizzle-orm mock, so it must be imported before the
// operators this file asserts on — `eq`/`inArray`/`isNull` are spies only
// through that mock.
import { mockDb, resetMockDb, asDb } from "../test-utils.ts";
import { eq, inArray, isNull } from "drizzle-orm";
import { agent as agentTable, mcp as mcpTable } from "../db/schema.ts";
import {
  resolveScoped,
  resolveScopedByName,
  listScoped,
  listScopedByIds,
  requireScoped,
  requireWorkspaceMutable,
  requireSharedDeletable,
  resolveOrgScoped,
  requireOrgScoped,
  listOrgScoped,
  listOrgScopedIds,
  orgScopedWhere,
  orgScopedWhereIn,
  isScopedResourceType,
} from "./scoped-resource.ts";
import { NotFoundError, LockedError, ConflictError } from "../errors.ts";

const ctx = { orgId: "org-1", workspaceId: "ws-1" };

describe("ScopedResource module", () => {
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

      const found = await resolveScoped(asDb(mockDb), "agent", "a1", ctx);
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

      const found = await resolveScoped(asDb(mockDb), "agent", "a1", ctx);
      expect(found).toEqual({ row, scope: "organization" });
    });

    it("returns null for an org-scoped row not attached here", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "a1", organizationId: "org-1", workspaceId: null },
        ])
        .mockResolvedValueOnce([]); // attachment check → not attached

      const found = await resolveScoped(asDb(mockDb), "agent", "a1", ctx);
      expect(found).toBeNull();
    });

    it("returns null when the resource is missing", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const found = await resolveScoped(asDb(mockDb), "agent", "a1", ctx);
      expect(found).toBeNull();
    });

    it("returns null for a row that carries this org and another workspace", async () => {
      // The scope columns are mutually exclusive on write, not by a database
      // constraint. Such a row belongs to ws-other, so matching it on
      // organizationId alone would make it visible in ws-1.
      mockDb.limit.mockResolvedValueOnce([
        { id: "a1", organizationId: "org-1", workspaceId: "ws-other" },
      ]);

      const found = await resolveScoped(asDb(mockDb), "agent", "a1", ctx);
      expect(found).toBeNull();
    });
  });

  describe("resolveScopedByName", () => {
    it("prefers the workspace-scoped row of that name", async () => {
      const row = { id: "s1", name: "triage", workspaceId: "ws-1" };
      mockDb.limit.mockResolvedValueOnce([row]);

      const found = await resolveScopedByName(
        asDb(mockDb),
        "skill",
        "triage",
        ctx,
      );
      expect(found).toEqual({ row, scope: "workspace" });
      // The Shared branch never ran — a Workspace row of the same name wins
      // outright rather than racing an unordered `LIMIT 1` against it.
      expect(mockDb.innerJoin).not.toHaveBeenCalled();
    });

    it("falls back to an attached org-scoped row of that name", async () => {
      const row = {
        id: "s2",
        name: "triage",
        organizationId: "org-1",
        workspaceId: null,
      };
      mockDb.limit
        .mockResolvedValueOnce([]) // no workspace-scoped row of this name
        .mockResolvedValueOnce([row]) // the Shared row
        .mockResolvedValueOnce([{ id: "att-1" }]); // attached here

      const found = await resolveScopedByName(
        asDb(mockDb),
        "skill",
        "triage",
        ctx,
      );
      expect(found).toEqual({ row, scope: "organization" });
    });

    it("returns null for an org-scoped row not attached here", async () => {
      mockDb.limit
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: "s2",
            name: "triage",
            organizationId: "org-1",
            workspaceId: null,
          },
        ])
        .mockResolvedValueOnce([]); // attachment check → not attached

      const found = await resolveScopedByName(
        asDb(mockDb),
        "skill",
        "triage",
        ctx,
      );
      expect(found).toBeNull();
    });

    it("returns null when no row of that name is visible", async () => {
      mockDb.limit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const found = await resolveScopedByName(
        asDb(mockDb),
        "skill",
        "triage",
        ctx,
      );
      expect(found).toBeNull();
    });
  });

  describe("resolveOrgScoped", () => {
    it("returns the Shared row of this organization", async () => {
      const row = { id: "a1", organizationId: "org-1", workspaceId: null };
      mockDb.limit.mockResolvedValueOnce([row]);

      const found = await resolveOrgScoped(
        asDb(mockDb),
        "agent",
        "a1",
        "org-1",
      );
      expect(found).toEqual(row);
      // Only genuinely Shared rows answer on the Organization surface: a row
      // carrying both scope columns belongs to its Workspace (ADR-0007).
      expect(isNull).toHaveBeenCalledWith(agentTable.workspaceId);
    });

    it("returns null when the resource is not Shared in this organization", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const found = await resolveOrgScoped(
        asDb(mockDb),
        "agent",
        "a1",
        "org-1",
      );
      expect(found).toBeNull();
    });
  });

  describe("orgScopedWhere", () => {
    it("matches on id, organization, and no workspace", () => {
      orgScopedWhere("agent", "a1", "org-1");

      expect(eq).toHaveBeenCalledWith(agentTable.id, "a1");
      expect(eq).toHaveBeenCalledWith(agentTable.organizationId, "org-1");
      // The part a hand-rolled `eq(organizationId)` write predicate leaves out:
      // a row carrying both scope columns belongs to its Workspace and must not
      // be written from the Organization surface (ADR-0007).
      expect(isNull).toHaveBeenCalledWith(agentTable.workspaceId);
    });

    it("resolves the columns of the type it is given", () => {
      orgScopedWhere("mcp", "m1", "org-1");

      expect(eq).toHaveBeenCalledWith(mcpTable.id, "m1");
      expect(isNull).toHaveBeenCalledWith(mcpTable.workspaceId);
    });
  });

  describe("orgScopedWhereIn", () => {
    it("matches on a set of ids, the organization, and no workspace", () => {
      const ids = ["a1", "a2"];
      orgScopedWhereIn("agent", ids, "org-1");

      expect(inArray).toHaveBeenCalledWith(agentTable.id, ids);
      expect(eq).toHaveBeenCalledWith(agentTable.organizationId, "org-1");
      expect(isNull).toHaveBeenCalledWith(agentTable.workspaceId);
    });
  });

  describe("listOrgScopedIds", () => {
    it("returns the subset of ids that are Shared here", async () => {
      const ids = ["a1", "a2", "gone"];
      mockDb.where.mockResolvedValueOnce([{ id: "a1" }, { id: "a2" }]);

      const found = await listOrgScopedIds(asDb(mockDb), "agent", ids, "org-1");
      expect(found).toEqual(new Set(["a1", "a2"]));
      expect(inArray).toHaveBeenCalledWith(agentTable.id, ids);
      expect(isNull).toHaveBeenCalledWith(agentTable.workspaceId);
    });

    it("returns an empty set without querying when given no ids", async () => {
      const found = await listOrgScopedIds(asDb(mockDb), "agent", [], "org-1");
      expect(found).toEqual(new Set());
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe("isScopedResourceType", () => {
    it("admits every registered resource type", () => {
      for (const type of ["agent", "skill", "mcp", "provider"]) {
        expect(isScopedResourceType(type)).toBe(true);
      }
    });

    it("rejects a missing or unregistered type", () => {
      expect(isScopedResourceType(undefined)).toBe(false);
      expect(isScopedResourceType("blueprint")).toBe(false);
      expect(isScopedResourceType("")).toBe(false);
    });

    it("rejects an inherited Object property name", () => {
      // The value reaches this guard straight from a query param or request
      // body, so membership is a real lookup rather than an `in` that would
      // walk the prototype chain and admit "constructor" as a resource type.
      expect(isScopedResourceType("constructor")).toBe(false);
    });
  });

  describe("requireOrgScoped", () => {
    it("throws NotFoundError when the resource is not Shared here", async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      await expect(
        requireOrgScoped(asDb(mockDb), "agent", "a1", "org-1"),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("returns the row when it is Shared here", async () => {
      const row = { id: "a1", organizationId: "org-1", workspaceId: null };
      mockDb.limit.mockResolvedValueOnce([row]);
      await expect(
        requireOrgScoped(asDb(mockDb), "agent", "a1", "org-1"),
      ).resolves.toEqual(row);
    });
  });

  describe("listOrgScoped", () => {
    it("lists this organization's Shared rows", async () => {
      const rows = [{ id: "a1", organizationId: "org-1", workspaceId: null }];
      mockDb.where.mockResolvedValueOnce(rows);

      const results = await listOrgScoped(asDb(mockDb), "agent", "org-1");
      expect(results).toEqual(rows);
      expect(isNull).toHaveBeenCalledWith(agentTable.workspaceId);
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

      const results = await listScoped(asDb(mockDb), "agent", ctx);
      expect(results).toEqual([
        { row: wsRow, scope: "workspace" },
        { row: orgRow, scope: "organization" },
      ]);
    });
  });

  describe("listScopedByIds", () => {
    it("unions workspace rows with attached org rows for the given ids", async () => {
      const wsRow = { id: "ws-a", workspaceId: "ws-1" };
      const orgRow = {
        id: "org-a",
        organizationId: "org-1",
        workspaceId: null,
      };
      mockDb.where
        .mockResolvedValueOnce([wsRow])
        .mockResolvedValueOnce([{ agent: orgRow }]);

      const ids = ["ws-a", "org-a", "invisible"];
      const results = await listScopedByIds(asDb(mockDb), "agent", ids, ctx);
      expect(results).toEqual([
        { row: wsRow, scope: "workspace" },
        { row: orgRow, scope: "organization" },
      ]);
      // Both scope branches are narrowed to the ids asked for — without this the
      // call would read every row of the type and filter in memory.
      expect(inArray).toHaveBeenCalledTimes(2);
      expect(inArray).toHaveBeenNthCalledWith(1, expect.anything(), ids);
      expect(inArray).toHaveBeenNthCalledWith(2, expect.anything(), ids);
    });

    it("applies no id filter when listing the whole type", async () => {
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await listScoped(asDb(mockDb), "agent", ctx);
      expect(inArray).not.toHaveBeenCalled();
    });

    it("returns an empty list without querying when given no ids", async () => {
      const results = await listScopedByIds(asDb(mockDb), "agent", [], ctx);
      expect(results).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe("requireScoped", () => {
    it("throws NotFoundError when not visible here", async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      await expect(
        requireScoped(asDb(mockDb), "agent", "a1", ctx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("returns the resolved row when visible", async () => {
      const row = { id: "a1", workspaceId: "ws-1", organizationId: null };
      mockDb.limit.mockResolvedValueOnce([row]);
      const found = await requireScoped(asDb(mockDb), "agent", "a1", ctx);
      expect(found).toEqual({ row, scope: "workspace" });
    });
  });

  describe("requireWorkspaceMutable", () => {
    it("returns a workspace row unchanged", async () => {
      const row = { id: "a1", workspaceId: "ws-1", organizationId: null };
      mockDb.limit.mockResolvedValueOnce([row]);
      const found = await requireWorkspaceMutable(
        asDb(mockDb),
        "agent",
        "a1",
        ctx,
      );
      expect(found).toEqual({ row, scope: "workspace" });
    });

    it("throws LockedError for an attached org-scoped row", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "a1", organizationId: "org-1", workspaceId: null },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]); // attached → visible but locked
      await expect(
        requireWorkspaceMutable(asDb(mockDb), "agent", "a1", ctx),
      ).rejects.toBeInstanceOf(LockedError);
    });

    it("throws NotFoundError (not Locked) when missing", async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      await expect(
        requireWorkspaceMutable(asDb(mockDb), "agent", "a1", ctx),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("requireSharedDeletable", () => {
    it("throws ConflictError while an Attachment references it", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "att-1" }]); // attachment lookup
      await expect(
        requireSharedDeletable(asDb(mockDb), "agent", "a1"),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("throws ConflictError while a Blueprint lists it", async () => {
      mockDb.limit
        .mockResolvedValueOnce([]) // attachment lookup → none
        .mockResolvedValueOnce([{ id: "item-1" }]); // blueprint lookup → listed
      await expect(
        requireSharedDeletable(asDb(mockDb), "agent", "a1"),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("resolves when nothing points at it", async () => {
      mockDb.limit
        .mockResolvedValueOnce([]) // attachment lookup → none
        .mockResolvedValueOnce([]); // blueprint lookup → none
      await expect(
        requireSharedDeletable(asDb(mockDb), "agent", "a1"),
      ).resolves.toBeUndefined();
    });

    it("uses the uppercase MCP acronym in the conflict message", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "att-1" }]);
      await expect(
        requireSharedDeletable(asDb(mockDb), "mcp", "m1"),
      ).rejects.toThrow(/this MCP is attached/);
    });
  });
});
