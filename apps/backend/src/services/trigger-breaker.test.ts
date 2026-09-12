import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import { notInArray } from "drizzle-orm";
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
  recordSuppressedTriggerRun,
  retainTriggerRuns,
  shouldSuppressTriggerRun,
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
        "Trigger run loop breaker configured",
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

  describe("recordSuppressedTriggerRun", () => {
    it("writes a suppressed row carrying the entity and the event", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));

      await recordSuppressedTriggerRun({
        triggerId: "trigger-1",
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
  });

  describe("retainTriggerRuns", () => {
    /**
     * The retention queries in call order: the newest normal rows, the normal
     * rows inside the breaker window, the newest suppressed rows — then one
     * delete per budget whose result the caller reads through `.returning`.
     */
    const stubRetention = ({
      newest,
      withinWindow,
      suppressed,
      deleted = [],
      deletedSuppressed = [],
    }: {
      newest: { id: string }[];
      withinWindow: { id: string }[];
      suppressed: { id: string }[];
      deleted?: { id: string }[];
      deletedSuppressed?: { id: string }[];
    }) => {
      mockDb.limit
        .mockResolvedValueOnce(newest)
        .mockResolvedValueOnce(suppressed);
      mockDb.where
        .mockImplementationOnce(() => mockDb)
        .mockResolvedValueOnce(withinWindow);
      mockDb.returning
        .mockResolvedValueOnce(deleted)
        .mockResolvedValueOnce(deletedSuppressed);
    };

    it("keeps every run inside the breaker window, however small maxRunsToKeep is", async () => {
      // The floor the breaker's count depends on: maxRunsToKeep alone would
      // have deleted `in-window` before the count could see it.
      vi.stubEnv(TRIGGER_BREAKER_WINDOW_SECONDS_ENV, "3600");
      stubRetention({
        newest: [{ id: "newest" }],
        withinWindow: [{ id: "in-window" }],
        suppressed: [],
      });

      await retainTriggerRuns("trigger-1", 1);

      expect(vi.mocked(notInArray)).toHaveBeenCalledWith(triggerRunTable.id, [
        "newest",
        "in-window",
      ]);
    });

    it("deduplicates a row that is both newest and inside the window", async () => {
      stubRetention({
        newest: [{ id: "newest" }, { id: "newer" }],
        withinWindow: [{ id: "newest" }],
        suppressed: [],
      });

      await retainTriggerRuns("trigger-1", 2);

      expect(vi.mocked(notInArray)).toHaveBeenCalledWith(triggerRunTable.id, [
        "newest",
        "newer",
      ]);
    });

    it("budgets suppressed rows separately from maxRunsToKeep", async () => {
      vi.stubEnv(TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP_ENV, "1");
      stubRetention({
        newest: [{ id: "newest" }],
        withinWindow: [],
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
