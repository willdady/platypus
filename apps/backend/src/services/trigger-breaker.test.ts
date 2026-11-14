import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import { mockLogger } from "../test-setup.ts";

import {
  shouldSuppressTriggerRun,
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
        maxRuns: 20,
        windowSeconds: 3600,
        suppressedRunsToKeep: 20,
      });
    });

    it("reads every setting from the environment", () => {
      expect(
        triggerBreakerConfig({
          TRIGGER_BREAKER_MAX_RUNS: "5",
          TRIGGER_BREAKER_WINDOW_SECONDS: "60",
          TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP: "3",
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
            triggerBreakerConfig({ TRIGGER_BREAKER_MAX_RUNS: raw }).maxRuns,
          ).toBe(20);
          return;
        }
        expect(() =>
          triggerBreakerConfig({ TRIGGER_BREAKER_MAX_RUNS: raw }),
        ).toThrow(/TRIGGER_BREAKER_MAX_RUNS must be a positive integer/);
      },
    );
  });

  describe("validateTriggerBreakerConfig", () => {
    it("fails startup on a malformed setting rather than defaulting it", () => {
      vi.stubEnv("TRIGGER_BREAKER_MAX_RUNS", "banana");

      expect(() => validateTriggerBreakerConfig()).toThrow(
        "TRIGGER_BREAKER_MAX_RUNS",
      );
    });

    it("reports the effective settings at boot", () => {
      vi.stubEnv("TRIGGER_BREAKER_MAX_RUNS", "5");

      expect(validateTriggerBreakerConfig()).toMatchObject({ maxRuns: 5 });
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ maxRuns: 5 }),
        "Trigger run-rate breaker configured",
      );
    });

    it("says out loud that a longer window retains more runs", () => {
      vi.stubEnv("TRIGGER_BREAKER_WINDOW_SECONDS", "7200");

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
      vi.stubEnv("TRIGGER_BREAKER_MAX_RUNS", "20");
      mockDb.where.mockResolvedValueOnce([{ runs: 20 }]);

      await expect(
        shouldSuppressTriggerRun("trigger-1", "card-1"),
      ).resolves.toBe(true);
    });

    it("allows the firing while the window is below the ceiling", async () => {
      vi.stubEnv("TRIGGER_BREAKER_MAX_RUNS", "20");
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
});
