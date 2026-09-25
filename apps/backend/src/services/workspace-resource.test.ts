import { describe, it, expect, beforeEach } from "vitest";
// test-utils installs the drizzle-orm mock, so it must be imported before the
// operators this file uses — `desc` is a marker only through that mock.
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";
import { desc } from "drizzle-orm";
import { db } from "../index.ts";
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
const dashboardId = "dash-1";

// Each table holds a row this Workspace (or Dashboard) owns and one with the
// same shape owned elsewhere, so a predicate that dropped its scope column
// reaches the other tenant's row and the test fails.
const ROWS = {
  chat: [
    { id: "chat-1", workspaceId, title: "Hello" },
    { id: "chat-2", workspaceId: "ws-2", title: "Theirs" },
  ],
  dashboard: [{ id: "dash-1", workspaceId, name: "Dashboard" }],
  trigger: [
    { id: "trig-old", workspaceId, createdAt: 1 },
    { id: "trig-new", workspaceId, createdAt: 2 },
    { id: "trig-other", workspaceId: "ws-2", createdAt: 3 },
  ],
  webhook: [
    { id: "wh-1", workspaceId },
    { id: "wh-2", workspaceId: "ws-2" },
  ],
  widget: [
    { id: "widget-1", dashboardId, data: null },
    { id: "widget-2", dashboardId: "dash-2", data: null },
  ],
  sandbox: [
    { id: "sbx-1", workspaceId, name: "Mine" },
    { id: "sbx-2", workspaceId: "ws-2", name: "Theirs" },
  ],
} satisfies Record<string, Row[]>;

const world = () => seedDb(structuredClone(ROWS));

describe("WorkspaceResource module", () => {
  let fake: ReturnType<typeof world>;

  beforeEach(() => {
    resetMockDb();
    fake = world();
  });

  describe("resolveOwned / requireOwned", () => {
    it("returns the row when it exists in this workspace", async () => {
      await expect(
        resolveOwned(db, "chat", { id: "chat-1", workspaceId }),
      ).resolves.toEqual(ROWS.chat[0]);
      await expect(
        requireOwned(db, "dashboard", { id: "dash-1", workspaceId }),
      ).resolves.toEqual(ROWS.dashboard[0]);
    });

    it("returns null for another workspace's row", async () => {
      await expect(
        resolveOwned(db, "chat", { id: "chat-2", workspaceId }),
      ).resolves.toBeNull();
    });

    it("throws NotFoundError with the type's label when missing", async () => {
      await expect(
        requireOwned(db, "dashboard", { id: "dash-9", workspaceId }),
      ).rejects.toThrow(new NotFoundError("Dashboard not found"));
      await expect(
        requireOwned(db, "trigger", { id: "trig-other", workspaceId }),
      ).rejects.toThrow(new NotFoundError("Trigger not found"));
    });
  });

  describe("listOwned", () => {
    it("lists only this workspace's rows, unordered when orderBy is null", async () => {
      await expect(
        listOwned(db, "webhook", { workspaceId }, null),
      ).resolves.toEqual([ROWS.webhook[0]]);
    });

    it("applies the order clause when one is passed", async () => {
      const rows = await listOwned(
        db,
        "trigger",
        { workspaceId },
        desc(triggerTable.createdAt),
      );
      expect(rows.map((r) => r.id)).toEqual(["trig-new", "trig-old"]);
    });
  });

  describe("updateOwned", () => {
    it("updates and returns this workspace's row", async () => {
      const result = await updateOwned(
        db,
        "chat",
        { id: "chat-1", workspaceId },
        { title: "Renamed" },
      );
      expect(result).toEqual({ ...ROWS.chat[0], title: "Renamed" });
      expect(fake.tables.chat[1].title).toBe("Theirs");
    });

    it("returns null and writes nothing for another workspace's row", async () => {
      const result = await updateOwned(
        db,
        "chat",
        { id: "chat-2", workspaceId },
        { title: "Renamed" },
      );
      expect(result).toBeNull();
      expect(fake.tables.chat).toEqual(ROWS.chat);
    });
  });

  describe("deleteOwned", () => {
    it("returns true when this workspace's row was deleted", async () => {
      await expect(
        deleteOwned(db, "webhook", { id: "wh-1", workspaceId }),
      ).resolves.toBe(true);
      expect(fake.tables.webhook).toEqual([ROWS.webhook[1]]);
    });

    it("returns false and deletes nothing for another workspace's row", async () => {
      await expect(
        deleteOwned(db, "webhook", { id: "wh-2", workspaceId }),
      ).resolves.toBe(false);
      expect(fake.tables.webhook).toEqual(ROWS.webhook);
    });
  });

  describe("ownedWhere", () => {
    it("throws when an id-bearing type is given no id", () => {
      // The type system requires `id` here; the cast simulates a caller bug
      // reaching past it (e.g. an absent route param) at runtime.
      const ref = { workspaceId } as never;
      expect(() => ownedWhere("chat", ref)).toThrow("requires an id");
    });
  });

  // --- Widget: nested under its Dashboard ---

  describe("widget", () => {
    it("resolves, lists, updates and deletes by dashboardId", async () => {
      const ref = { id: "widget-1", dashboardId };
      await expect(resolveOwned(db, "widget", ref)).resolves.toEqual(
        ROWS.widget[0],
      );
      await expect(
        listOwned(db, "widget", { dashboardId }, null),
      ).resolves.toEqual([ROWS.widget[0]]);
      await expect(
        updateOwned(db, "widget", ref, { data: { value: 1 } }),
      ).resolves.toMatchObject({ data: { value: 1 } });
      await expect(deleteOwned(db, "widget", ref)).resolves.toBe(true);
      expect(fake.tables.widget).toEqual([ROWS.widget[1]]);
    });

    it("does not reach another dashboard's widget", async () => {
      const ref = { id: "widget-2", dashboardId };
      await expect(requireOwned(db, "widget", ref)).rejects.toThrow(
        new NotFoundError("Widget not found"),
      );
      await expect(
        updateOwned(db, "widget", ref, { data: { value: 1 } }),
      ).resolves.toBeNull();
      await expect(deleteOwned(db, "widget", ref)).resolves.toBe(false);
      expect(fake.tables.widget).toEqual(ROWS.widget);
    });
  });

  // --- Sandbox: one-per-Workspace singleton, addressed by scope alone ---

  describe("sandbox", () => {
    it("resolves, updates and deletes the workspace's sandbox by workspaceId alone", async () => {
      await expect(
        resolveOwned(db, "sandbox", { workspaceId }),
      ).resolves.toEqual(ROWS.sandbox[0]);
      await expect(
        updateOwned(db, "sandbox", { workspaceId }, { name: "Renamed" }),
      ).resolves.toEqual({ ...ROWS.sandbox[0], name: "Renamed" });
      await expect(deleteOwned(db, "sandbox", { workspaceId })).resolves.toBe(
        true,
      );
      expect(fake.tables.sandbox).toEqual([ROWS.sandbox[1]]);
    });

    it("requireOwned throws NotFoundError when none configured", async () => {
      await expect(
        requireOwned(db, "sandbox", { workspaceId: "ws-3" }),
      ).rejects.toThrow(new NotFoundError("Sandbox not configured"));
    });
  });
});
