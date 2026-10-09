import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import { mockLogger } from "../test-setup.ts";

const { mockDispatchWebhookEvent } = vi.hoisted(() => ({
  mockDispatchWebhookEvent: vi.fn(),
}));

vi.mock("./event-dispatch.ts", () => ({
  dispatchWebhookEvent: mockDispatchWebhookEvent,
}));

import { announceTriggerRunsEnded } from "./trigger-run-announce.ts";

const startedAt = new Date("2026-01-01T00:00:00Z");
const completedAt = new Date("2026-01-01T00:01:00Z");

const endedRun = (over: Record<string, unknown> = {}) => ({
  runId: "run-1",
  triggerId: "trigger-1",
  status: "failed",
  startedAt,
  completedAt,
  errorMessage: "boom",
  eventType: "card.updated",
  entityId: "card-1",
  unloadedToolSets: [
    { toolSetId: "mcp-1", name: "Jira", reason: "unreachable" as const },
  ],
  failedToolCalls: 2,
  ...over,
});

const triggerRow = (over: Record<string, unknown> = {}) => ({
  id: "trigger-1",
  name: "Card triage",
  type: "event",
  agentId: "agent-1",
  workspaceId: "ws-1",
  organizationId: "org-1",
  ...over,
});

describe("announceTriggerRunsEnded", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  it("delivers the run's terminal event with its Trigger's coordinates", async () => {
    mockDb.where.mockResolvedValueOnce([triggerRow()]);

    await announceTriggerRunsEnded([endedRun()]);

    expect(mockDispatchWebhookEvent).toHaveBeenCalledTimes(1);
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith("org-1", "ws-1", {
      event: "trigger_run.failed",
      data: {
        runId: "run-1",
        status: "failed",
        startedAt,
        completedAt,
        errorMessage: "boom",
        triggerId: "trigger-1",
        triggerName: "Card triage",
        triggerType: "event",
        agentId: "agent-1",
        eventType: "card.updated",
        entityId: "card-1",
        unloadedToolSets: [
          { toolSetId: "mcp-1", name: "Jira", reason: "unreachable" },
        ],
        failedToolCalls: 2,
      },
    });
  });

  it.each([
    ["success", "trigger_run.succeeded"],
    ["failed", "trigger_run.failed"],
    ["cancelled", "trigger_run.cancelled"],
    ["suppressed", "trigger_run.suppressed"],
  ])("names a %s run %s", async (status, event) => {
    mockDb.where.mockResolvedValueOnce([triggerRow()]);

    await announceTriggerRunsEnded([endedRun({ status })]);

    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      "org-1",
      "ws-1",
      expect.objectContaining({
        event,
        data: expect.objectContaining({ status }) as unknown,
      }),
    );
  });

  it("announces each of several runs once", async () => {
    mockDb.where.mockResolvedValueOnce([triggerRow()]);

    await announceTriggerRunsEnded([
      endedRun({ runId: "run-1" }),
      endedRun({ runId: "run-2" }),
    ]);

    const runIds = mockDispatchWebhookEvent.mock.calls.map(
      (call) => (call[2] as { data: { runId: string } }).data.runId,
    );
    expect(runIds).toEqual(["run-1", "run-2"]);
  });

  it("announces nothing for a run whose Trigger was deleted", async () => {
    mockDb.where.mockResolvedValueOnce([]);

    await announceTriggerRunsEnded([endedRun()]);

    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("announces nothing for a run that has not ended", async () => {
    mockDb.where.mockResolvedValueOnce([triggerRow()]);

    await announceTriggerRunsEnded([endedRun({ status: "running" })]);

    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("does not query for an empty batch", async () => {
    await announceTriggerRunsEnded([]);

    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("logs rather than throws when the lookup fails", async () => {
    mockDb.where.mockRejectedValueOnce(new Error("db down"));

    await expect(
      announceTriggerRunsEnded([endedRun()]),
    ).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalled();
    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });
});
