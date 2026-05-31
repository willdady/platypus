import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import {
  resolveRunTimeouts,
  readRunTimeoutCeilings,
} from "./agent-run-settings.ts";

const ENV_KEYS = [
  "RUN_PER_RUN_TIMEOUT_MS",
  "RUN_PER_STEP_TIMEOUT_MS",
  "TRIGGER_PER_RUN_TIMEOUT_MS",
  "TRIGGER_PER_STEP_TIMEOUT_MS",
];

describe("agent-run-settings", () => {
  let original: Record<string, string | undefined>;

  beforeEach(() => {
    original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    resetMockDb();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  describe("readRunTimeoutCeilings", () => {
    it("returns the documented defaults when env is unset", () => {
      const chat = readRunTimeoutCeilings("chat");
      expect(chat).toEqual({
        perRunTimeoutMs: 10 * 60 * 1000,
        perStepTimeoutMs: 2 * 60 * 1000,
      });
      const trigger = readRunTimeoutCeilings("trigger");
      expect(trigger).toEqual({
        perRunTimeoutMs: 60 * 60 * 1000,
        perStepTimeoutMs: 10 * 60 * 1000,
      });
    });

    it("honors env overrides", () => {
      process.env.RUN_PER_RUN_TIMEOUT_MS = "1800000";
      process.env.TRIGGER_PER_STEP_TIMEOUT_MS = "300000";
      expect(readRunTimeoutCeilings("chat").perRunTimeoutMs).toBe(1800000);
      expect(readRunTimeoutCeilings("trigger").perStepTimeoutMs).toBe(300000);
    });

    it("falls back to default when env is non-numeric or non-positive", () => {
      process.env.RUN_PER_RUN_TIMEOUT_MS = "garbage";
      process.env.RUN_PER_STEP_TIMEOUT_MS = "-100";
      const chat = readRunTimeoutCeilings("chat");
      expect(chat.perRunTimeoutMs).toBe(10 * 60 * 1000);
      expect(chat.perStepTimeoutMs).toBe(2 * 60 * 1000);
    });
  });

  describe("resolveRunTimeouts", () => {
    beforeEach(() => {
      process.env.RUN_PER_RUN_TIMEOUT_MS = "600000";
      process.env.RUN_PER_STEP_TIMEOUT_MS = "120000";
    });

    it("returns ceilings when orgId is null", async () => {
      const r = await resolveRunTimeouts(null, "chat");
      expect(r).toEqual({ perRunTimeoutMs: 600000, perStepTimeoutMs: 120000 });
    });

    it("reads org override and clamps to ceiling", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          agentRunSettings: {
            chatPerRunTimeoutMs: 999_999_999,
            chatPerStepTimeoutMs: 60000,
          },
        },
      ]);
      const r = await resolveRunTimeouts("org-1", "chat");
      // run was 999_999_999, clamped to 600000; step was 60000, kept
      expect(r).toEqual({ perRunTimeoutMs: 600000, perStepTimeoutMs: 60000 });
    });

    it("ignores trigger settings when resolving chat", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          agentRunSettings: {
            triggerPerRunTimeoutMs: 60000,
            triggerPerStepTimeoutMs: 60000,
          },
        },
      ]);
      const r = await resolveRunTimeouts("org-1", "chat");
      expect(r).toEqual({ perRunTimeoutMs: 600000, perStepTimeoutMs: 120000 });
    });

    it("returns ceiling when org has no settings row", async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      const r = await resolveRunTimeouts("org-1", "trigger");
      expect(r.perRunTimeoutMs).toBeGreaterThan(0);
    });
  });
});
