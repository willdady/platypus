import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import { lte, notInArray } from "drizzle-orm";
import { triggerRun as triggerRunTable } from "../db/schema.ts";

vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "suppressed-1"),
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../logger.ts", () => ({ logger: mockLogger }));

import {
  DEFAULT_TRIGGER_BREAKER_MAX_RUNS,
  DEFAULT_TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP,
  DEFAULT_TRIGGER_BREAKER_WINDOW_SECONDS,
  retainTriggerRuns,
  shouldSuppressTriggerRun,
  suppressTriggerRun,
  TRIGGER_BREAKER_MAX_RUNS_ENV,
  TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP_ENV,
  TRIGGER_BREAKER_WINDOW_SECONDS_ENV,
  triggerBreakerConfig,
  validateTriggerBreakerConfig,
} from "./trigger-breaker.ts";

describe("trigger-breaker", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  describe("triggerBreakerConfig", () => {
    it("uses the proposed defaults when nothing is set", () => {
      expect(triggerBreakerConfig({})).toEqual({
        maxRuns: DEFAULT_TRIGGER_BREAKER_MAX_RUNS,
        windowSeconds: DEFAULT_TRIGGER_BREAKER_WINDOW_SECONDS,
        suppressedRunsToKeep: DEFAULT_TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP,
      });
    });

    it("reads every setting from the environment", () => {
      expect(
        triggerBreakerConfig({
          [TRIGGER_BREAKER_MAX_RUNS_ENV]: "5",
          [TRIGGER_BREAKER_WINDOW_SECONDS_ENV]: "60",
          [TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP_ENV]: "3",
        }),
      ).toEqual({ maxRuns: 5, windowSeconds: 60, suppressedRunsToKeep: 3 });
    });

    // An explicitly-set value that is not a positive integer must not be
    // replaced by a number the Operator never chose: a limit that enforces
    // something other than it reads is worse than no limit at all.
    it.each(["banana", "0", "-1", "1.5", "  "])(
      "refuses the value %j rather than defaulting it",
      (raw) => {
        if (raw.trim() === "") {
          expect(
            triggerBreakerConfig({ [TRIGGER_BREAKER_MAX_RUNS_ENV]: raw })
              .maxRuns,
          ).toBe(DEFAULT_TRIGGER_BREAKER_MAX_RUNS);
          return;
        }
        expect(() =>
          triggerBreakerConfig({ [TRIGGER_BREAKER_MAX_RUNS_ENV]: raw }),
        ).toThrow(/TRIGGER_BREAKER_MAX_RUNS must be a positive integer/);
      },
    );
  });

  describe("validateTriggerBreakerConfig", () => {
    it("fails startup on a malformed setting rather than defaulting it", () => {
      vi.stubEnv(TRIGGER_BREAKER_MAX_RUNS_ENV, "banana");

      expect(() => validateTriggerBreakerConfig()).toThrow(
        TRIGGER_BREAKER_MAX_RUNS_ENV,
      );
    });

    it("reports the effective settings at boot", () => {
      vi.stubEnv(TRIGGER_BREAKER_MAX_RUNS_ENV, "5");

      expect(validateTriggerBreakerConfig()).toMatchObject({ maxRuns: 5 });
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ maxRuns: 5 }),
        "Trigger run-rate breaker configured",
      );
    });

    it("says out loud that a longer window retains more runs", () => {
      vi.stubEnv(TRIGGER_BREAKER_WINDOW_SECONDS_ENV, "7200");

      validateTriggerBreakerConfig();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ windowSeconds: 7200 }),
        expect.stringContaining("retained for the whole window"),
      );
    });

    it("says nothing when the window is the default", () => {
      validateTriggerBreakerConfig();

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe("shouldSuppressTriggerRun", () => {
    it("suppresses once the window holds the ceiling, not one run later", async () => {
      vi.stubEnv(TRIGGER_BREAKER_MAX_RUNS_ENV, "20");
      mockDb.where.mockResolvedValueOnce([{ runs: 20 }]);

      await expect(
        shouldSuppressTriggerRun("trigger-1", "card-1"),
      ).resolves.toBe(true);
    });

    it("allows the firing while the window is below the ceiling", async () => {
      vi.stubEnv(TRIGGER_BREAKER_MAX_RUNS_ENV, "20");
      mockDb.where.mockResolvedValueOnce([{ runs: 19 }]);

      await expect(
        shouldSuppressTriggerRun("trigger-1", "card-1"),
      ).resolves.toBe(false);
    });

    it("treats an entity with no runs in the window as empty, not unknown", async () => {
      mockDb.where.mockResolvedValueOnce([]);

      await expect(
        shouldSuppressTriggerRun("trigger-1", "card-1"),
      ).resolves.toBe(false);
    });
  });

  describe("suppressTriggerRun", () => {
    it("writes a suppressed row carrying the entity and the event", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
      mockDb.limit.mockResolvedValue([]);

      await suppressTriggerRun({
        triggerId: "trigger-1",
        maxRunsToKeep: 10,
        entityId: "card-1",
        eventType: "card.updated",
        eventData: { id: "card-1" },
      });

      const inserted = mockDb.values.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(inserted).toMatchObject({
        id: "suppressed-1",
        triggerId: "trigger-1",
        status: "suppressed",
        entityId: "card-1",
        eventType: "card.updated",
        eventData: { id: "card-1" },
      });
      expect(inserted.startedAt).toEqual(new Date("2026-01-01T12:00:00Z"));
      expect(inserted.createdAt).toEqual(new Date("2026-01-01T12:00:00Z"));
    });

    it("trims the Trigger's history with the row it just wrote", async () => {
      // A runaway produces suppressed rows fast; recording one without
      // retention would let the evidence of the trip fill the table.
      mockDb.limit.mockResolvedValue([]);

      await suppressTriggerRun({
        triggerId: "trigger-1",
        maxRunsToKeep: 10,
        entityId: "card-1",
        eventType: "card.updated",
        eventData: { id: "card-1" },
      });

      // Both retention budgets were consulted — newest normal rows and newest
      // suppressed rows — so the write came with its cleanup.
      expect(mockDb.select).toHaveBeenCalledTimes(2);
    });
  });

  describe("retainTriggerRuns", () => {
    /**
     * The retention queries in call order: the newest normal rows, the normal
     * rows inside the breaker window, the newest suppressed rows — then one
     * delete per budget whose result the caller reads through `.returning`.
     */
    const stubRetention = ({
      newest,
      suppressed,
      deleted = [],
      deletedSuppressed = [],
    }: {
      newest: { id: string }[];
      suppressed: { id: string }[];
      deleted?: { id: string }[];
      deletedSuppressed?: { id: string }[];
    }) => {
      mockDb.limit
        .mockResolvedValueOnce(newest)
        .mockResolvedValueOnce(suppressed);
      mockDb.returning
        .mockResolvedValueOnce(deleted)
        .mockResolvedValueOnce(deletedSuppressed);
    };

    it("keeps every run inside the breaker window, however small maxRunsToKeep is", async () => {
      // The floor the breaker's count depends on: maxRunsToKeep alone would
      // have deleted the in-window rows before the count could see them. They
      // are spared by predicate rather than by id, so the delete cannot grow
      // an id list with the Trigger's throughput.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
      vi.stubEnv(TRIGGER_BREAKER_WINDOW_SECONDS_ENV, "3600");
      stubRetention({ newest: [{ id: "newest" }], suppressed: [] });

      await retainTriggerRuns("trigger-1", 1);

      expect(vi.mocked(lte)).toHaveBeenCalledWith(
        triggerRunTable.startedAt,
        new Date("2026-01-01T11:00:00Z"),
      );
    });

    it("carries no more ids into the delete than maxRunsToKeep", async () => {
      // The regression this guards: the kept set used to be the union of the
      // newest page and every row inside the window, so a Trigger firing
      // across many entities built an unbounded `notInArray` argument on a
      // query that runs after every run.
      stubRetention({
        newest: [{ id: "newest" }, { id: "newer" }],
        suppressed: [],
      });

      await retainTriggerRuns("trigger-1", 2);

      expect(vi.mocked(notInArray)).toHaveBeenCalledWith(triggerRunTable.id, [
        "newest",
        "newer",
      ]);
      // Two selects only — the newest page and the suppressed page. A third
      // would be the window scan this replaced.
      expect(mockDb.select).toHaveBeenCalledTimes(2);
    });

    it("derives the kept window from the configured breaker window", async () => {
      // The floor is the Operator's window, read at runtime: a test pinned to
      // a module constant could not cover a value set at deploy time.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
      vi.stubEnv(TRIGGER_BREAKER_WINDOW_SECONDS_ENV, "60");
      stubRetention({ newest: [{ id: "newest" }], suppressed: [] });

      await retainTriggerRuns("trigger-1", 1);

      expect(vi.mocked(lte)).toHaveBeenCalledWith(
        triggerRunTable.startedAt,
        new Date("2026-01-01T11:59:00Z"),
      );
    });

    it("budgets suppressed rows separately from maxRunsToKeep", async () => {
      vi.stubEnv(TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP_ENV, "1");
      stubRetention({
        newest: [{ id: "newest" }],
        suppressed: [{ id: "suppressed-newest" }],
      });

      await retainTriggerRuns("trigger-1", 1);

      expect(vi.mocked(notInArray)).toHaveBeenNthCalledWith(
        2,
        triggerRunTable.id,
        ["suppressed-newest"],
      );
    });

    it("does not prune when the Trigger holds fewer rows than either budget", async () => {
      // A short page from either budget means it returned every row there is.
      mockDb.limit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await retainTriggerRuns("trigger-1", 10);

      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("still budgets suppressed rows when maxRunsToKeep is zero", async () => {
      vi.stubEnv(TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP_ENV, "1");
      mockDb.limit.mockResolvedValueOnce([{ id: "suppressed-newest" }]);
      mockDb.returning.mockResolvedValueOnce([]);

      await retainTriggerRuns("trigger-1", 0);

      expect(vi.mocked(notInArray)).toHaveBeenCalledWith(triggerRunTable.id, [
        "suppressed-newest",
      ]);
    });
  });
});
