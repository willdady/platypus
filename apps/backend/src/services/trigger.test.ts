import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

vi.mock("../utils/cron.ts", () => ({
  validateCronExpression: vi.fn((expr: string) => {
    if (expr === "invalid") return null;
    return new Date("2026-01-01T10:00:00Z");
  }),
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "trig-new"),
}));

import {
  createTrigger,
  updateTrigger,
  type TriggerCreateFields,
  type TriggerUpdateFields,
} from "./trigger.ts";
import { NotFoundError, ValidationError } from "../errors.ts";

const ctx = { orgId: "org-1", workspaceId: "ws-1" };

const cronFields = (): TriggerCreateFields => ({
  agentId: "agent-1",
  type: "cron",
  name: "Daily",
  instruction: "Do something",
  enabled: true,
  maxRunsToKeep: 10,
  search: false,
  includeMemories: false,
  config: { cronExpression: "0 9 * * *", timezone: "UTC", isOneOff: false },
});

const eventFields = (): TriggerCreateFields => ({
  agentId: "agent-1",
  type: "event",
  name: "On Card",
  instruction: "Handle card",
  enabled: true,
  maxRunsToKeep: 10,
  search: false,
  includeMemories: false,
  config: { events: ["card.created"] },
});

describe("trigger module", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  describe("createTrigger", () => {
    it("computes nextRunAt and inserts a cron trigger", async () => {
      const inserted = { id: "trig-new", type: "cron" };
      mockDb.returning.mockResolvedValueOnce([inserted]);

      const row = await createTrigger(ctx, cronFields());

      expect(row).toEqual(inserted);
      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.workspaceId).toBe("ws-1");
      expect(values.nextRunAt).toEqual(new Date("2026-01-01T10:00:00Z"));
    });

    it("throws ValidationError for an invalid cron expression", async () => {
      await expect(
        createTrigger(ctx, {
          ...cronFields(),
          config: {
            cronExpression: "invalid",
            timezone: "UTC",
            isOneOff: false,
          },
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError when cronExpression is missing", async () => {
      await expect(
        createTrigger(ctx, {
          ...cronFields(),
          config: {} as never,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("inserts an event trigger with a full filters shape (columnId, changedFields)", async () => {
      const inserted = { id: "trig-new", type: "event" };
      mockDb.returning.mockResolvedValueOnce([inserted]);

      await createTrigger(ctx, {
        ...eventFields(),
        config: {
          events: ["card.created", "card.updated"],
          filters: {
            boardId: "board-1",
            columnId: "col-1",
            changedFields: ["title", "body"],
          },
        },
      });

      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.config).toEqual({
        events: ["card.created", "card.updated"],
        filters: {
          boardId: "board-1",
          columnId: "col-1",
          changedFields: ["title", "body"],
        },
      });
      expect(values.nextRunAt).toBeNull();
    });

    it("throws ValidationError for an empty events array", async () => {
      await expect(
        createTrigger(ctx, { ...eventFields(), config: { events: [] } }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError for an event name outside the real enum", async () => {
      await expect(
        createTrigger(ctx, {
          ...eventFields(),
          config: { events: ["card.commented"] as never },
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError for a filters object with an unknown-shaped field", async () => {
      await expect(
        createTrigger(ctx, {
          ...eventFields(),
          config: {
            events: ["card.created"],
            filters: { changedFields: "not-an-array" as never },
          },
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError for an unrecognized trigger type", async () => {
      await expect(
        createTrigger(ctx, {
          ...cronFields(),
          type: "invalid" as never,
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("updateTrigger", () => {
    it("throws NotFoundError when the trigger doesn't exist in this workspace", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(
        updateTrigger(ctx, "trig-missing", { name: "x" }),
      ).rejects.toThrow(NotFoundError);
    });

    it("recomputes nextRunAt when a cron trigger's config changes", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "trig-1",
          type: "cron",
          config: { cronExpression: "0 9 * * *", timezone: "UTC" },
        },
      ]);
      const updated = { id: "trig-1", name: "Updated" };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const row = await updateTrigger(ctx, "trig-1", {
        name: "Updated",
        config: {
          cronExpression: "0 10 * * *",
          timezone: "UTC",
          isOneOff: false,
        },
      });

      expect(row).toEqual(updated);
      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.nextRunAt).toEqual(new Date("2026-01-01T10:00:00Z"));
    });

    it("leaves nextRunAt untouched when a cron trigger's config/type are not part of the update", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "trig-1",
          type: "cron",
          config: { cronExpression: "0 9 * * *", timezone: "UTC" },
        },
      ]);
      mockDb.returning.mockResolvedValueOnce([
        { id: "trig-1", enabled: false },
      ]);

      await updateTrigger(ctx, "trig-1", { enabled: false });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg).not.toHaveProperty("nextRunAt");
    });

    it("throws ValidationError for an invalid cron expression on update", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "trig-1",
          type: "cron",
          config: { cronExpression: "0 9 * * *", timezone: "UTC" },
        },
      ]);

      await expect(
        updateTrigger(ctx, "trig-1", {
          config: {
            cronExpression: "invalid",
            timezone: "UTC",
            isOneOff: false,
          },
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("clears nextRunAt when switching to event type", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "trig-1",
          type: "cron",
          config: { cronExpression: "0 9 * * *", timezone: "UTC" },
        },
      ]);
      mockDb.returning.mockResolvedValueOnce([{ id: "trig-1", type: "event" }]);

      await updateTrigger(ctx, "trig-1", {
        type: "event",
        config: { events: ["card.created"] },
      });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.nextRunAt).toBeNull();
    });

    // A type change re-reads the stored config under the other shape's schema.
    // Without it, a cron config survives under `type: "event"`: the cron
    // scheduler skips it (nextRunAt is nulled) and the event dispatcher never
    // matches it (no `events`), so the Trigger looks configured and can never
    // fire. The cron branch already guarded the mirror case.
    it("throws ValidationError when flipping to event type without a config", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "trig-1",
          type: "cron",
          config: { cronExpression: "0 9 * * *", timezone: "UTC" },
        },
      ]);

      await expect(
        updateTrigger(ctx, "trig-1", { type: "event" }),
      ).rejects.toThrow(ValidationError);
    });

    // The mirror of the above, kept alongside it so the symmetry is visible.
    it("throws ValidationError when flipping to cron type without a config", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "trig-1", type: "event", config: { events: ["card.created"] } },
      ]);

      await expect(
        updateTrigger(ctx, "trig-1", { type: "cron" }),
      ).rejects.toThrow(ValidationError);
    });

    // The guard keys on the type *field being present*, not on it changing, so
    // a caller that re-sends the type it already has must still succeed — the
    // stored config revalidates cleanly under its own schema.
    it("accepts a no-op event type on update, leaving the stored config alone", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "trig-1",
          type: "event",
          config: { events: ["card.created"], filters: { boardId: "board-1" } },
        },
      ]);
      mockDb.returning.mockResolvedValueOnce([{ id: "trig-1", type: "event" }]);

      await updateTrigger(ctx, "trig-1", { type: "event", name: "renamed" });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.name).toBe("renamed");
      // Untouched: validated, not rewritten, because no config was supplied.
      expect(setArg.config).toBeUndefined();
    });

    it("throws ValidationError for an empty events array on update", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "trig-1", type: "event", config: { events: ["card.created"] } },
      ]);

      await expect(
        updateTrigger(ctx, "trig-1", { config: { events: [] } }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError for an event name outside the real enum on update", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "trig-1", type: "event", config: { events: ["card.created"] } },
      ]);

      await expect(
        updateTrigger(ctx, "trig-1", {
          config: { events: ["card.commented"] as never },
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("round-trips a columnId/changedFields filter through a full-replace config update", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "trig-1",
          type: "event",
          config: { events: ["card.created"], filters: { boardId: "board-1" } },
        },
      ]);
      mockDb.returning.mockResolvedValueOnce([{ id: "trig-1" }]);

      const newConfig: TriggerUpdateFields["config"] = {
        events: ["card.updated"],
        filters: {
          boardId: "board-1",
          columnId: "col-2",
          changedFields: ["priority"],
        },
      };

      await updateTrigger(ctx, "trig-1", { config: newConfig });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.config).toEqual(newConfig);
    });

    it("replaces config wholesale rather than merging — omitting filters on update drops the old ones", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "trig-1",
          type: "event",
          config: {
            events: ["card.created"],
            filters: { boardId: "board-1", columnId: "col-1" },
          },
        },
      ]);
      mockDb.returning.mockResolvedValueOnce([{ id: "trig-1" }]);

      await updateTrigger(ctx, "trig-1", {
        config: { events: ["card.created", "card.updated"] },
      });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.config).toEqual({
        events: ["card.created", "card.updated"],
      });
    });

    it("leaves config untouched when not supplied", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "trig-1",
          type: "event",
          config: { events: ["card.created"] },
        },
      ]);
      mockDb.returning.mockResolvedValueOnce([{ id: "trig-1" }]);

      await updateTrigger(ctx, "trig-1", { enabled: false });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg).not.toHaveProperty("config");
    });
  });
});
