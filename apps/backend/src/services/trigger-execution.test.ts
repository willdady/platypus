import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

const { mockGenerate, mockValidateCronExpression } = vi.hoisted(() => ({
  mockGenerate: vi.fn(),
  mockValidateCronExpression: vi.fn(),
}));

vi.mock("../runs/agent-runner.ts", () => ({
  agentRunner: { generate: mockGenerate },
}));

const { TriggerSinkSpy } = vi.hoisted(() => ({
  TriggerSinkSpy: vi.fn(),
}));

vi.mock("../runs/sinks/trigger-sink.ts", () => ({
  TriggerSink: class {
    constructor(params: unknown) {
      TriggerSinkSpy(params);
    }
    onStart() {}
    onResolved() {}
    onProgress() {}
    onFinish() {}
  },
}));

vi.mock("../utils/cron.ts", () => ({
  validateCronExpression: mockValidateCronExpression,
}));

vi.mock("../logger.ts", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "test-id"),
}));

import { executeTrigger, updateTriggerAfterRun } from "./trigger-execution.ts";

const baseTrigger = {
  id: "trigger-1",
  workspaceId: "ws-1",
  agentId: "agent-1",
  type: "cron" as const,
  name: "Test Trigger",
  description: null,
  instruction: "Do something",
  enabled: true,
  maxRunsToKeep: 10,
  search: false,
  config: { cronExpression: "0 * * * *", timezone: "UTC", isOneOff: false },
  lastRunAt: null,
  nextRunAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockWorkspace = {
  id: "ws-1",
  organizationId: "org-1",
  ownerId: "user-1",
  name: "Test Workspace",
  context: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("trigger-execution", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    process.env.FRONTEND_URL = "http://localhost:3000";
  });

  describe("executeTrigger", () => {
    it("returns a runId and delegates execution to agentRunner.generate", async () => {
      mockDb.limit.mockResolvedValueOnce([mockWorkspace]);
      mockGenerate.mockResolvedValueOnce({ text: "ok", stats: {} });

      const runId = await executeTrigger(baseTrigger);

      expect(runId).toBe("test-id");
      expect(mockGenerate).toHaveBeenCalledTimes(1);
      const args = mockGenerate.mock.calls[0][0];
      expect(args.scope.orgId).toBe("org-1");
      expect(args.scope.workspaceId).toBe("ws-1");
      expect(args.scope.principal.kind).toBe("trigger");
      expect(args.scope.principal.triggerId).toBe("trigger-1");
      expect(args.scope.principal.onBehalfOfUserId).toBe("user-1");
      expect(args.input.runId).toBe("test-id");
      expect(args.input.request.agentId).toBe("agent-1");
      expect(args.input.messages).toHaveLength(1);
      expect(args.input.messages[0].parts[0].text).toBe("Do something");
    });

    it("prepends event context to the instruction for event triggers", async () => {
      mockDb.limit.mockResolvedValueOnce([mockWorkspace]);
      mockGenerate.mockResolvedValueOnce({ text: "ok", stats: {} });

      await executeTrigger(baseTrigger, {
        eventType: "card.created",
        eventData: { cardId: "c1" },
      });

      const args = mockGenerate.mock.calls[0][0];
      const text = args.input.messages[0].parts[0].text;
      expect(text).toContain("Event: card.created");
      expect(text).toContain('"cardId": "c1"');
      expect(text).toContain("Do something");
    });

    it("constructs a TriggerSink with the trigger id and event metadata", async () => {
      mockDb.limit.mockResolvedValueOnce([mockWorkspace]);
      mockGenerate.mockResolvedValueOnce({ text: "ok", stats: {} });

      await executeTrigger(baseTrigger, {
        eventType: "card.created",
        eventData: { cardId: "c1" },
      });

      expect(TriggerSinkSpy).toHaveBeenCalledWith({
        triggerId: "trigger-1",
        eventType: "card.created",
        eventData: { cardId: "c1" },
      });
    });

    it("propagates a search override from the trigger to the run input", async () => {
      mockDb.limit.mockResolvedValueOnce([mockWorkspace]);
      mockGenerate.mockResolvedValueOnce({ text: "ok", stats: {} });

      const trigger = { ...baseTrigger, search: true };
      await executeTrigger(trigger);

      const args = mockGenerate.mock.calls[0][0];
      expect(args.input.request.search).toBe(true);
    });

    it("throws when the workspace is not found, before invoking the runner", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(executeTrigger(baseTrigger as any)).rejects.toThrow(
        "Workspace 'ws-1' not found",
      );
      expect(mockGenerate).not.toHaveBeenCalled();
    });

    it("rethrows runner failures so callers can log/observe", async () => {
      mockDb.limit.mockResolvedValueOnce([mockWorkspace]);
      mockGenerate.mockRejectedValueOnce(new Error("Model error"));

      await expect(executeTrigger(baseTrigger as any)).rejects.toThrow(
        "Model error",
      );
    });
  });

  describe("updateTriggerAfterRun", () => {
    it("should update lastRunAt and compute nextRunAt for cron triggers", async () => {
      const nextRun = new Date("2026-01-01T01:00:00Z");
      mockValidateCronExpression.mockReturnValue(nextRun);
      mockDb.limit.mockResolvedValue([]);

      await updateTriggerAfterRun("trigger-1", baseTrigger);

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          nextRunAt: nextRun,
          enabled: true,
        }),
      );
    });

    it("should disable one-off cron triggers after execution", async () => {
      mockDb.limit.mockResolvedValue([]);
      const trigger = {
        ...baseTrigger,
        config: {
          cronExpression: "0 * * * *",
          timezone: "UTC",
          isOneOff: true,
        },
      } as any;

      await updateTriggerAfterRun("trigger-1", trigger);

      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
          nextRunAt: null,
        }),
      );
    });

    it("should set nextRunAt to null for event triggers", async () => {
      mockDb.limit.mockResolvedValue([]);
      const trigger = {
        ...baseTrigger,
        type: "event",
        config: { events: ["card.created"] },
      } as any;

      await updateTriggerAfterRun("trigger-1", trigger);

      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          nextRunAt: null,
          enabled: true,
        }),
      );
    });

    it("should perform retention cleanup when maxRunsToKeep > 0", async () => {
      mockValidateCronExpression.mockReturnValue(new Date());
      mockDb.limit.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({ id: `item-${i}` })),
      );
      mockDb.returning.mockResolvedValue([]);

      await updateTriggerAfterRun("trigger-1", baseTrigger);

      expect(mockDb.select).toHaveBeenCalled();
    });

    it("should skip retention cleanup when maxRunsToKeep is 0", async () => {
      mockValidateCronExpression.mockReturnValue(new Date());
      const trigger = { ...baseTrigger, maxRunsToKeep: 0 } as any;

      resetMockDb();
      await updateTriggerAfterRun("trigger-1", trigger);

      expect(mockDb.update).toHaveBeenCalled();
    });
  });
});
