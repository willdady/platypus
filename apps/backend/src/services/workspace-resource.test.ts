import { describe, it, expect, beforeEach, vi } from "vitest";
// test-utils installs the drizzle-orm mock, so it must be imported before the
// operators this file asserts on — `eq`/`and` are spies only through that mock.
import { mockDb, resetMockDb, asDb } from "../test-utils.ts";
import { desc } from "drizzle-orm";
import { trigger as triggerTable } from "../db/schema.ts";
import {
  resolveOwned,
  requireOwned,
  listOwned,
  updateOwned,
  deleteOwned,
  ownedWhere,
} from "./workspace-resource.ts";
import { NotFoundError } from "../errors.ts";

const workspaceId = "ws-1";

describe("WorkspaceResource module", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  describe("resolveOwned", () => {
    it("returns the row when it exists in this workspace", async () => {
      const row = { id: "chat-1", workspaceId, title: "Hello" };
      mockDb.limit.mockResolvedValueOnce([row]);

      const found = await resolveOwned(asDb(mockDb), "chat", {
        id: "chat-1",
        workspaceId,
      });
      expect(found).toEqual(row);
    });

    it("returns null when the row is missing", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const found = await resolveOwned(asDb(mockDb), "chat", {
        id: "chat-1",
        workspaceId,
      });
      expect(found).toBeNull();
    });
  });

  describe("requireOwned", () => {
    it("returns the row when found", async () => {
      const row = { id: "dash-1", workspaceId, name: "Dashboard" };
      mockDb.limit.mockResolvedValueOnce([row]);

      const found = await requireOwned(asDb(mockDb), "dashboard", {
        id: "dash-1",
        workspaceId,
      });
      expect(found).toEqual(row);
    });

    it("throws NotFoundError with the type's label when missing", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(
        requireOwned(asDb(mockDb), "dashboard", {
          id: "dash-1",
          workspaceId,
        }),
      ).rejects.toThrow(NotFoundError);
      await expect(
        requireOwned(asDb(mockDb), "trigger", { id: "trig-1", workspaceId }),
      ).rejects.toThrow("Trigger not found");
    });
  });

  describe("listOwned", () => {
    it("resolves via .where() alone when orderBy is null", async () => {
      const rows = [{ id: "wh-1", workspaceId }];
      mockDb.where.mockResolvedValueOnce(rows);

      const results = await listOwned(
        asDb(mockDb),
        "webhook",
        { workspaceId },
        null,
      );
      expect(results).toEqual(rows);
      expect(mockDb.orderBy).not.toHaveBeenCalled();
    });

    it("chains .orderBy() when an order clause is passed", async () => {
      const rows = [{ id: "trig-1", workspaceId }];
      mockDb.orderBy.mockResolvedValueOnce(rows);

      const results = await listOwned(
        asDb(mockDb),
        "trigger",
        { workspaceId },
        desc(triggerTable.createdAt),
      );
      expect(results).toEqual(rows);
      expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
    });
  });

  describe("updateOwned", () => {
    it("returns the updated row on success", async () => {
      const updated = { id: "chat-1", workspaceId, title: "Renamed" };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await updateOwned(
        asDb(mockDb),
        "chat",
        { id: "chat-1", workspaceId },
        {
          title: "Renamed",
        },
      );
      expect(result).toEqual(updated);
    });

    it("returns null when nothing matched", async () => {
      mockDb.returning.mockResolvedValueOnce([]);

      const result = await updateOwned(
        asDb(mockDb),
        "chat",
        { id: "chat-1", workspaceId },
        {
          title: "Renamed",
        },
      );
      expect(result).toBeNull();
    });
  });

  describe("deleteOwned", () => {
    it("returns true when a row was deleted", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "wh-1" }]);

      const deleted = await deleteOwned(asDb(mockDb), "webhook", {
        id: "wh-1",
        workspaceId,
      });
      expect(deleted).toBe(true);
    });

    it("returns false when nothing matched", async () => {
      mockDb.returning.mockResolvedValueOnce([]);

      const deleted = await deleteOwned(asDb(mockDb), "webhook", {
        id: "wh-1",
        workspaceId,
      });
      expect(deleted).toBe(false);
    });
  });

  describe("ownedWhere", () => {
    it("is a concrete SQL condition, not undefined", () => {
      expect(ownedWhere("chat", { id: "chat-1", workspaceId })).toBeTruthy();
    });

    it("throws when an id-bearing type is given no id", () => {
      // The type system requires `id` here; the cast simulates a caller bug
      // reaching past it (e.g. an absent route param) at runtime.
      const ref = { workspaceId } as never;
      expect(() => ownedWhere("chat", ref)).toThrow("requires an id");
    });
  });

  // --- Widget: nested under its Dashboard ---

  const dashboardId = "dash-1";

  describe("widget resolve / require", () => {
    it("resolves a widget scoped to its dashboard", async () => {
      const row = { id: "widget-1", dashboardId };
      mockDb.limit.mockResolvedValueOnce([row]);

      const found = await resolveOwned(asDb(mockDb), "widget", {
        id: "widget-1",
        dashboardId,
      });
      expect(found).toEqual(row);
    });

    it("requireOwned throws NotFoundError when missing", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(
        requireOwned(asDb(mockDb), "widget", { id: "widget-1", dashboardId }),
      ).rejects.toThrow("Widget not found");
    });
  });

  describe("widget list / update / delete", () => {
    it("lists the widgets on a dashboard", async () => {
      const rows = [{ id: "widget-1", dashboardId }];
      mockDb.where.mockResolvedValueOnce(rows);

      const results = await listOwned(
        asDb(mockDb),
        "widget",
        { dashboardId },
        null,
      );
      expect(results).toEqual(rows);
    });

    it("updates a widget scoped to its dashboard", async () => {
      const updated = { id: "widget-1", dashboardId, data: { value: 1 } };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await updateOwned(
        asDb(mockDb),
        "widget",
        { id: "widget-1", dashboardId },
        {
          data: { value: 1 },
        },
      );
      expect(result).toEqual(updated);
    });

    it("deletes a widget scoped to its dashboard", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "widget-1" }]);

      const deleted = await deleteOwned(asDb(mockDb), "widget", {
        id: "widget-1",
        dashboardId,
      });
      expect(deleted).toBe(true);
    });

    it("scopes the predicate by dashboardId, not workspaceId", () => {
      expect(
        ownedWhere("widget", { id: "widget-1", dashboardId }),
      ).toBeTruthy();
    });
  });

  // --- Sandbox: one-per-Workspace singleton, addressed by scope alone ---

  describe("sandbox resolve / require", () => {
    it("resolves the workspace's sandbox", async () => {
      const row = { id: "sbx-1", workspaceId, backend: "docker" };
      mockDb.limit.mockResolvedValueOnce([row]);

      const found = await resolveOwned(asDb(mockDb), "sandbox", {
        workspaceId,
      });
      expect(found).toEqual(row);
    });

    it("requireOwned throws NotFoundError when none configured", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(
        requireOwned(asDb(mockDb), "sandbox", { workspaceId }),
      ).rejects.toThrow("Sandbox not configured");
    });
  });

  describe("sandbox update / delete", () => {
    it("updates the workspace's sandbox, scoped by workspaceId alone", async () => {
      const updated = { id: "sbx-1", workspaceId, name: "Renamed" };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await updateOwned(
        asDb(mockDb),
        "sandbox",
        { workspaceId },
        { name: "Renamed" },
      );
      expect(result).toEqual(updated);
    });

    it("deletes the workspace's sandbox", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "sbx-1" }]);

      const deleted = await deleteOwned(asDb(mockDb), "sandbox", {
        workspaceId,
      });
      expect(deleted).toBe(true);
    });
  });
});
