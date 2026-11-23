import { describe, it, expect, beforeEach, vi } from "vitest";
// why: first, since drizzle-orm's operators are spies only through test-utils' mock
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";
import { eq, isNull } from "drizzle-orm";
import { db } from "../index.ts";
import { agent as agentTable, mcp as mcpTable } from "../db/schema.ts";
import {
  resolveScoped,
  resolveScopedByName,
  listScoped,
  listScopedByIds,
  listScopedByIdsForWorkspaces,
  requireScoped,
  requireWorkspaceMutable,
  requireSharedDeletable,
  resolveOrgScoped,
  requireOrgScoped,
  listOrgScoped,
  listOrgScopedIds,
  orgScopedWhere,
  workspaceScopedWhere,
  isScopedResourceType,
} from "./scoped-resource.ts";
import { NotFoundError, LockedError, ConflictError } from "../errors.ts";

const ctx = { orgId: "org-1", workspaceId: "ws-1" };

const agentRow = (
  id: string,
  workspaceId: string | null,
  organizationId: string | null,
  name = id,
): Row => ({ id, name, workspaceId, organizationId });

const AGENTS = {
  mine: agentRow("mine", "ws-1", null, "triage"),
  sibling: agentRow("sibling", "ws-2", null, "sibling"),
  shared: agentRow("shared", null, "org-1", "shared"),
  loose: agentRow("loose", null, "org-1", "loose"),
  foreign: agentRow("foreign", null, "org-2", "foreign"),
  dual: agentRow("dual", "ws-other", "org-1", "dual"),
};

const attachment = (
  id: string,
  workspaceId: string,
  resourceId: string,
  resourceType = "agent",
): Row => ({ id, workspaceId, resourceType, resourceId });

const world = (extra: Record<string, Row[]> = {}) =>
  seedDb({
    agent: Object.values(AGENTS),
    attachment: [
      attachment("att-shared", "ws-1", "shared"),
      attachment("att-foreign", "ws-1", "foreign"),
      attachment("att-loose-ws2", "ws-2", "loose"),
    ],
    ...extra,
  });

describe("ScopedResource module", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  describe("resolveScoped", () => {
    beforeEach(() => world());

    it("returns a workspace-scoped row tagged scope workspace", async () => {
      await expect(resolveScoped(db, "agent", "mine", ctx)).resolves.toEqual({
        row: AGENTS.mine,
        scope: "workspace",
      });
    });

    it("returns an attached org-scoped row tagged scope organization", async () => {
      await expect(resolveScoped(db, "agent", "shared", ctx)).resolves.toEqual({
        row: AGENTS.shared,
        scope: "organization",
      });
    });

    it.each([
      ["another Workspace's row", "sibling"],
      ["a Shared row attached only to another Workspace", "loose"],
      ["another Organization's Shared row, even if attached here", "foreign"],
      ["a row carrying this org and another workspace", "dual"],
      ["a missing row", "gone"],
    ])("returns null for %s", async (_label, id) => {
      await expect(resolveScoped(db, "agent", id, ctx)).resolves.toBeNull();
    });

    it("only honours an Attachment for the same resource type", async () => {
      seedDb({
        agent: [AGENTS.shared],
        attachment: [attachment("att-1", "ws-1", "shared", "skill")],
      });

      await expect(
        resolveScoped(db, "agent", "shared", ctx),
      ).resolves.toBeNull();
    });
  });

  describe("resolveScopedByName", () => {
    it("prefers the workspace-scoped row of that name", async () => {
      const sameName = agentRow("shared-triage", null, "org-1", "triage");
      world({
        agent: [...Object.values(AGENTS), sameName],
        attachment: [attachment("att-1", "ws-1", "shared-triage")],
      });

      await expect(
        resolveScopedByName(db, "agent", "triage", ctx),
      ).resolves.toEqual({ row: AGENTS.mine, scope: "workspace" });
    });

    it("falls back to an attached org-scoped row of that name", async () => {
      world();
      await expect(
        resolveScopedByName(db, "agent", "shared", ctx),
      ).resolves.toEqual({ row: AGENTS.shared, scope: "organization" });
    });

    it.each([
      ["another Workspace's row", "sibling"],
      ["an unattached Shared row", "loose"],
      ["another Organization's row", "foreign"],
      ["an unknown name", "nope"],
    ])("returns null for %s", async (_label, name) => {
      world();
      await expect(
        resolveScopedByName(db, "agent", name, ctx),
      ).resolves.toBeNull();
    });

    it("restricts both branches to the allowed ids", async () => {
      world();
      await expect(
        resolveScopedByName(db, "agent", "triage", ctx, ["shared"]),
      ).resolves.toBeNull();
      await expect(
        resolveScopedByName(db, "agent", "shared", ctx, ["mine"]),
      ).resolves.toBeNull();
      await expect(
        resolveScopedByName(db, "agent", "shared", ctx, ["shared"]),
      ).resolves.toEqual({ row: AGENTS.shared, scope: "organization" });
    });
  });

  describe("resolveOrgScoped / requireOrgScoped", () => {
    beforeEach(() => world());

    it("returns the Shared row of this organization", async () => {
      await expect(
        resolveOrgScoped(db, "agent", "loose", "org-1"),
      ).resolves.toEqual(AGENTS.loose);
      await expect(
        requireOrgScoped(db, "agent", "loose", "org-1"),
      ).resolves.toEqual(AGENTS.loose);
    });

    it.each([
      ["a Workspace row", "mine"],
      ["another Organization's Shared row", "foreign"],
      ["a row carrying both scope columns", "dual"],
      ["a missing row", "gone"],
    ])("does not answer for %s", async (_label, id) => {
      await expect(
        resolveOrgScoped(db, "agent", id, "org-1"),
      ).resolves.toBeNull();
      await expect(requireOrgScoped(db, "agent", id, "org-1")).rejects.toThrow(
        new NotFoundError("Agent not found"),
      );
    });
  });

  describe("orgScopedWhere", () => {
    it("matches on id, organization, and no workspace", () => {
      orgScopedWhere("agent", "a1", "org-1");

      expect(eq).toHaveBeenCalledWith(agentTable.id, "a1");
      expect(eq).toHaveBeenCalledWith(agentTable.organizationId, "org-1");
      expect(isNull).toHaveBeenCalledWith(agentTable.workspaceId);
    });

    it("resolves the columns of the type it is given", () => {
      orgScopedWhere("mcp", "m1", "org-1");

      expect(eq).toHaveBeenCalledWith(mcpTable.id, "m1");
      expect(isNull).toHaveBeenCalledWith(mcpTable.workspaceId);
    });
  });

  describe("workspaceScopedWhere", () => {
    it("matches on id and workspace — the write-side counterpart to resolveScoped", () => {
      workspaceScopedWhere("agent", "a1", "ws-1");

      expect(eq).toHaveBeenCalledWith(agentTable.id, "a1");
      expect(eq).toHaveBeenCalledWith(agentTable.workspaceId, "ws-1");
    });

    it("resolves the columns of the type it is given", () => {
      workspaceScopedWhere("mcp", "m1", "ws-1");

      expect(eq).toHaveBeenCalledWith(mcpTable.id, "m1");
      expect(eq).toHaveBeenCalledWith(mcpTable.workspaceId, "ws-1");
    });
  });

  describe("listOrgScopedIds", () => {
    it("returns the subset of ids that are Shared in this organization", async () => {
      world();
      const found = await listOrgScopedIds(
        db,
        "agent",
        ["shared", "loose", "mine", "foreign", "dual", "gone"],
        "org-1",
      );
      expect(found).toEqual(new Set(["shared", "loose"]));
    });

    it("returns an empty set without querying when given no ids", async () => {
      const fake = world();
      const select = vi.spyOn(fake.handle as typeof db, "select");

      await expect(listOrgScopedIds(db, "agent", [], "org-1")).resolves.toEqual(
        new Set(),
      );
      expect(select).not.toHaveBeenCalled();
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
      expect(isScopedResourceType("constructor")).toBe(false);
    });
  });

  describe("listOrgScoped", () => {
    it("lists only this organization's Shared rows", async () => {
      world();
      await expect(listOrgScoped(db, "agent", "org-1")).resolves.toEqual([
        AGENTS.shared,
        AGENTS.loose,
      ]);
    });
  });

  describe("listScoped / listScopedByIds", () => {
    beforeEach(() => world());

    it("unions this Workspace's rows with the Shared rows attached here", async () => {
      await expect(listScoped(db, "agent", ctx)).resolves.toEqual([
        { row: AGENTS.mine, scope: "workspace" },
        { row: AGENTS.shared, scope: "organization" },
      ]);
    });

    it("narrows both branches to the ids asked for", async () => {
      const second = agentRow("mine-2", "ws-1", null);
      world({ agent: [...Object.values(AGENTS), second] });

      await expect(
        listScopedByIds(
          db,
          "agent",
          ["mine-2", "shared", "sibling", "loose", "foreign"],
          ctx,
        ),
      ).resolves.toEqual([
        { row: second, scope: "workspace" },
        { row: AGENTS.shared, scope: "organization" },
      ]);
    });

    it("returns an empty list without querying when given no ids", async () => {
      const fake = world();
      const select = vi.spyOn(fake.handle as typeof db, "select");

      await expect(listScopedByIds(db, "agent", [], ctx)).resolves.toEqual([]);
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe("listScopedByIdsForWorkspaces", () => {
    beforeEach(() => world());

    it("resolves each Workspace's own rows and the Shared rows attached there", async () => {
      await expect(
        listScopedByIdsForWorkspaces(
          db,
          "agent",
          ["mine", "shared", "sibling", "loose", "foreign"],
          [ctx, { orgId: "org-1", workspaceId: "ws-2" }],
        ),
      ).resolves.toEqual(
        new Map([
          [
            "ws-1",
            new Map([
              ["mine", { row: AGENTS.mine, scope: "workspace" }],
              ["shared", { row: AGENTS.shared, scope: "organization" }],
            ]),
          ],
          [
            "ws-2",
            new Map([
              ["sibling", { row: AGENTS.sibling, scope: "workspace" }],
              ["loose", { row: AGENTS.loose, scope: "organization" }],
            ]),
          ],
        ]),
      );
    });

    it("queries a fixed number of tables however many Workspaces it is given", async () => {
      const fake = world();

      const countReads = async (contexts: (typeof ctx)[]) => {
        fake.queries.length = 0;
        await listScopedByIdsForWorkspaces(
          db,
          "agent",
          ["mine", "shared", "sibling", "loose"],
          contexts,
        );
        return fake.queries.filter((q) => q.table === "agent").length;
      };

      expect(await countReads([ctx])).toBe(2);
      expect(
        await countReads([
          ctx,
          { orgId: "org-1", workspaceId: "ws-2" },
          { orgId: "org-1", workspaceId: "ws-3" },
          { orgId: "org-2", workspaceId: "ws-4" },
        ]),
      ).toBe(2);
    });

    it("gives every Workspace the Shared rows attached to it", async () => {
      world({
        attachment: [
          attachment("att-shared-ws1", "ws-1", "shared"),
          attachment("att-shared-ws2", "ws-2", "shared"),
        ],
      });

      const visible = await listScopedByIdsForWorkspaces(
        db,
        "agent",
        ["shared"],
        [ctx, { orgId: "org-1", workspaceId: "ws-2" }],
      );

      for (const workspaceId of ["ws-1", "ws-2"]) {
        expect(visible.get(workspaceId)?.get("shared")).toEqual({
          row: AGENTS.shared,
          scope: "organization",
        });
      }
    });

    it("returns empty maps without querying when given no ids", async () => {
      const fake = world();
      const select = vi.spyOn(fake.handle as typeof db, "select");

      await expect(
        listScopedByIdsForWorkspaces(db, "agent", [], [ctx]),
      ).resolves.toEqual(new Map([["ws-1", new Map()]]));
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe("requireScoped", () => {
    beforeEach(() => world());

    it("throws NotFoundError when not visible here", async () => {
      await expect(requireScoped(db, "agent", "sibling", ctx)).rejects.toThrow(
        new NotFoundError("Agent not found"),
      );
    });

    it("returns the resolved row when visible", async () => {
      await expect(requireScoped(db, "agent", "shared", ctx)).resolves.toEqual({
        row: AGENTS.shared,
        scope: "organization",
      });
    });
  });

  describe("requireWorkspaceMutable", () => {
    beforeEach(() => world());

    it("returns a workspace row unchanged", async () => {
      await expect(
        requireWorkspaceMutable(db, "agent", "mine", ctx),
      ).resolves.toEqual({ row: AGENTS.mine, scope: "workspace" });
    });

    it("throws LockedError for an attached org-scoped row", async () => {
      await expect(
        requireWorkspaceMutable(db, "agent", "shared", ctx),
      ).rejects.toThrow(
        new LockedError("This agent is managed at the organization level"),
      );
    });

    it.each(["gone", "loose", "sibling"])(
      "throws NotFoundError (not Locked) for invisible row %s",
      async (id) => {
        await expect(
          requireWorkspaceMutable(db, "agent", id, ctx),
        ).rejects.toBeInstanceOf(NotFoundError);
      },
    );
  });

  describe("requireSharedDeletable", () => {
    it("throws ConflictError while an Attachment references it", async () => {
      world();
      await expect(
        requireSharedDeletable(db, "agent", "loose"),
      ).rejects.toThrow(
        new ConflictError(
          "Cannot delete: this agent is attached to one or more workspaces. Detach it first.",
        ),
      );
    });

    it("throws ConflictError while a Blueprint lists it", async () => {
      seedDb({
        blueprint_item: [
          { id: "item-1", resourceType: "agent", resourceId: "a1" },
        ],
      });
      await expect(requireSharedDeletable(db, "agent", "a1")).rejects.toThrow(
        /listed in one or more blueprints/,
      );
    });

    it("resolves when only another resource type points at the id", async () => {
      seedDb({
        attachment: [attachment("att-1", "ws-1", "a1", "skill")],
        blueprint_item: [
          { id: "item-1", resourceType: "mcp", resourceId: "a1" },
        ],
      });
      await expect(
        requireSharedDeletable(db, "agent", "a1"),
      ).resolves.toBeUndefined();
    });

    it("uses the uppercase MCP acronym in the conflict message", async () => {
      seedDb({ attachment: [attachment("att-1", "ws-1", "m1", "mcp")] });
      await expect(requireSharedDeletable(db, "mcp", "m1")).rejects.toThrow(
        /this MCP is attached/,
      );
    });
  });
});
