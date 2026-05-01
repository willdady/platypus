import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockNoSession,
  mockSession,
  resetMockDb,
} from "../test-utils.ts";

const { mockValidateCronExpression } = vi.hoisted(() => ({
  mockValidateCronExpression: vi.fn(),
}));

vi.mock("../utils/cron.ts", () => ({
  validateCronExpression: mockValidateCronExpression,
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "trig-new"),
}));

import app from "../server.ts";

const orgId = "org-1";
const workspaceId = "ws-1";
const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/triggers`;

const cronTrigger = {
  id: "trig-1",
  workspaceId,
  agentId: "agent-1",
  type: "cron" as const,
  name: "Daily",
  description: null,
  instruction: "Do something",
  enabled: true,
  maxRunsToKeep: 10,
  search: false,
  config: { cronExpression: "0 9 * * *", timezone: "UTC", isOneOff: false },
  lastRunAt: null,
  nextRunAt: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const eventTrigger = {
  ...cronTrigger,
  id: "trig-2",
  type: "event" as const,
  config: { events: ["card.created"] },
};

/** Stub the two middleware DB lookups (requireOrgAccess + requireWorkspaceAccess). */
const stubAuthLookups = () => {
  mockSession();
  mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
  mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
};

describe("Trigger Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    mockDb.orderBy.mockReturnValue(mockDb);
    mockDb.limit.mockReturnValue(mockDb);
    mockDb.offset.mockReturnValue(mockDb);
  });

  describe("GET /", () => {
    it("lists all triggers in the workspace", async () => {
      stubAuthLookups();
      mockDb.orderBy.mockResolvedValueOnce([cronTrigger, eventTrigger]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: unknown[] };
      expect(body.results).toHaveLength(2);
    });

    it("requires authentication", async () => {
      mockNoSession();
      const res = await app.request(baseUrl);
      expect(res.status).toBe(401);
    });
  });

  describe("GET /:triggerId", () => {
    it("returns the trigger when found", async () => {
      stubAuthLookups();
      mockDb.limit.mockResolvedValueOnce([cronTrigger]);

      const res = await app.request(`${baseUrl}/trig-1`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ id: "trig-1", agentId: "agent-1" });
    });

    it("returns 404 when not found in this workspace", async () => {
      stubAuthLookups();
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/trig-missing`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Trigger not found" });
    });
  });

  describe("POST /", () => {
    const createBody = {
      workspaceId,
      agentId: "agent-1",
      type: "cron",
      name: "Daily",
      instruction: "Do something",
      enabled: true,
      maxRunsToKeep: 10,
      search: false,
      config: { cronExpression: "0 9 * * *", timezone: "UTC", isOneOff: false },
    };

    it("creates a cron trigger and returns 201", async () => {
      stubAuthLookups();
      mockDb.limit.mockResolvedValueOnce([{ id: "agent-1", workspaceId }]); // agent verify
      const nextRun = new Date("2026-02-01T09:00:00Z");
      mockValidateCronExpression.mockReturnValueOnce(nextRun);
      mockDb.returning.mockResolvedValueOnce([
        { ...cronTrigger, id: "trig-new", nextRunAt: nextRun },
      ]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(createBody),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; nextRunAt: string };
      expect(body.id).toBe("trig-new");
      expect(body.nextRunAt).toBe(nextRun.toISOString());
    });

    it("rejects invalid cron expressions with 400", async () => {
      stubAuthLookups();
      mockDb.limit.mockResolvedValueOnce([{ id: "agent-1", workspaceId }]);
      mockValidateCronExpression.mockReturnValueOnce(null);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          ...createBody,
          config: { cronExpression: "not-a-cron", timezone: "UTC" },
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Invalid cron expression or timezone",
      });
    });

    it("rejects creation when the agent is not in the workspace", async () => {
      stubAuthLookups();
      mockDb.limit.mockResolvedValueOnce([]); // agent verify: not found

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(createBody),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Agent not found in this workspace",
      });
    });

    it("rejects an event trigger with no events", async () => {
      stubAuthLookups();
      mockDb.limit.mockResolvedValueOnce([{ id: "agent-1", workspaceId }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          ...createBody,
          type: "event",
          config: { events: [] },
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("PUT /:triggerId", () => {
    it("updates a trigger and recomputes nextRunAt when the cron config changes", async () => {
      stubAuthLookups();
      mockDb.limit.mockResolvedValueOnce([cronTrigger]); // existing
      const nextRun = new Date("2026-02-02T09:00:00Z");
      mockValidateCronExpression.mockReturnValueOnce(nextRun);
      mockDb.returning.mockResolvedValueOnce([
        { ...cronTrigger, name: "Updated", nextRunAt: nextRun },
      ]);

      const res = await app.request(`${baseUrl}/trig-1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Updated",
          config: {
            cronExpression: "0 10 * * *",
            timezone: "UTC",
            isOneOff: false,
          },
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe("Updated");
      expect(mockValidateCronExpression).toHaveBeenCalledWith(
        "0 10 * * *",
        "UTC",
      );
    });

    it("returns 404 when the trigger doesn't exist in this workspace", async () => {
      stubAuthLookups();
      mockDb.limit.mockResolvedValueOnce([]); // existing not found

      const res = await app.request(`${baseUrl}/trig-missing`, {
        method: "PUT",
        body: JSON.stringify({ name: "x" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("rejects an agent change when the new agent is not in the workspace", async () => {
      stubAuthLookups();
      mockDb.limit.mockResolvedValueOnce([cronTrigger]); // existing
      mockDb.limit.mockResolvedValueOnce([]); // new agent not found

      const res = await app.request(`${baseUrl}/trig-1`, {
        method: "PUT",
        body: JSON.stringify({ agentId: "agent-other" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Agent not found in this workspace",
      });
    });

    it("clears nextRunAt when switching to event type", async () => {
      stubAuthLookups();
      mockDb.limit.mockResolvedValueOnce([cronTrigger]); // existing
      mockDb.returning.mockResolvedValueOnce([
        { ...cronTrigger, type: "event", nextRunAt: null },
      ]);

      const res = await app.request(`${baseUrl}/trig-1`, {
        method: "PUT",
        body: JSON.stringify({
          type: "event",
          config: { events: ["card.created"] },
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      const setArg = mockDb.set.mock.calls[0][0];
      expect(setArg.nextRunAt).toBeNull();
    });
  });

  describe("DELETE /:triggerId", () => {
    it("deletes the trigger when found", async () => {
      stubAuthLookups();
      mockDb.returning.mockResolvedValueOnce([cronTrigger]);

      const res = await app.request(`${baseUrl}/trig-1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Trigger deleted" });
    });

    it("returns 404 when the trigger doesn't exist", async () => {
      stubAuthLookups();
      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/trig-missing`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /:triggerId/runs", () => {
    it("lists trigger runs ordered by start time", async () => {
      stubAuthLookups();
      mockDb.limit.mockResolvedValueOnce([cronTrigger]); // trigger verify

      const runs = [
        { id: "run-1", triggerId: "trig-1", status: "success" },
        { id: "run-2", triggerId: "trig-1", status: "failed" },
      ];
      mockDb.offset.mockResolvedValueOnce(runs);

      const res = await app.request(`${baseUrl}/trig-1/runs`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: unknown[] };
      expect(body.results).toHaveLength(2);
    });

    it("returns 404 when the trigger doesn't exist in this workspace", async () => {
      stubAuthLookups();
      mockDb.limit.mockResolvedValueOnce([]); // trigger verify: not found

      const res = await app.request(`${baseUrl}/trig-missing/runs`);
      expect(res.status).toBe(404);
    });
  });
});
