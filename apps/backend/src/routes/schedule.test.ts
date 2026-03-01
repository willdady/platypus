import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  mockNoSession,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";

// Mock the cron utility
vi.mock("../utils/cron.ts", () => ({
  validateCronExpression: vi
    .fn()
    .mockReturnValue(new Date("2026-01-01T09:00:00Z")),
}));

describe("Schedule Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/schedules`;

  const authAndAccess = () => {
    mockSession();
    // requireOrgAccess
    mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
    // requireWorkspaceAccess
    mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
  };

  describe("GET /", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(baseUrl);
      expect(res.status).toBe(401);
    });

    it("should list all schedules in workspace", async () => {
      authAndAccess();
      const mockSchedules = [{ id: "sched-1", name: "Test Schedule" }];
      mockDb.orderBy.mockResolvedValueOnce(mockSchedules);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockSchedules });
    });
  });

  describe("GET /:scheduleId", () => {
    it("should return 404 if schedule not found", async () => {
      authAndAccess();
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/sched-1`);
      expect(res.status).toBe(404);
    });

    it("should return schedule if found", async () => {
      authAndAccess();
      const mockSchedule = { id: "sched-1", name: "Test Schedule" };
      mockDb.limit.mockResolvedValueOnce([mockSchedule]);

      const res = await app.request(`${baseUrl}/sched-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockSchedule);
    });
  });

  describe("POST /", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Test",
          agentId: "agent-1",
          instruction: "Do something",
          cronExpression: "0 9 * * *",
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it("should create schedule with valid data", async () => {
      authAndAccess();
      // Agent exists check
      mockDb.limit.mockResolvedValueOnce([{ id: "agent-1" }]);
      // Insert returning
      const mockSchedule = { id: "sched-1", name: "Test Schedule" };
      mockDb.returning.mockResolvedValueOnce([mockSchedule]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Test Schedule",
          agentId: "agent-1",
          instruction: "Do something",
          cronExpression: "0 9 * * *",
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockSchedule);
    });

    it("should return 400 if agent not found", async () => {
      authAndAccess();
      // Agent not found
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Test Schedule",
          agentId: "nonexistent",
          instruction: "Do something",
          cronExpression: "0 9 * * *",
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
    });

    it("should return 400 if name is missing", async () => {
      authAndAccess();

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          agentId: "agent-1",
          instruction: "Do something",
          cronExpression: "0 9 * * *",
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("PUT /:scheduleId", () => {
    it("should update schedule with partial body", async () => {
      authAndAccess();
      // Schedule exists
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "sched-1",
          agentId: "agent-1",
          cronExpression: "0 9 * * *",
          timezone: "UTC",
        },
      ]);
      const updated = { id: "sched-1", name: "Updated" };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const res = await app.request(`${baseUrl}/sched-1`, {
        method: "PUT",
        body: JSON.stringify({ name: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(updated);
    });

    it("should return 404 if schedule not found", async () => {
      authAndAccess();
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/sched-1`, {
        method: "PUT",
        body: JSON.stringify({ name: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:scheduleId", () => {
    it("should delete schedule", async () => {
      authAndAccess();
      mockDb.returning.mockResolvedValueOnce([{ id: "sched-1" }]);

      const res = await app.request(`${baseUrl}/sched-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Schedule deleted" });
    });
  });

  describe("GET /:scheduleId/runs", () => {
    it("should return runs with default pagination", async () => {
      authAndAccess();
      // Schedule exists
      mockDb.limit.mockResolvedValueOnce([{ id: "sched-1" }]);
      // Runs query
      const mockRuns = [{ id: "run-1", status: "success" }];
      mockDb.offset.mockResolvedValueOnce(mockRuns);

      const res = await app.request(`${baseUrl}/sched-1/runs`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockRuns });
    });

    it("should return 404 if schedule not found", async () => {
      authAndAccess();
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/sched-1/runs`);
      expect(res.status).toBe(404);
    });

    it("should accept limit and offset params", async () => {
      authAndAccess();
      mockDb.limit.mockResolvedValueOnce([{ id: "sched-1" }]);
      mockDb.offset.mockResolvedValueOnce([]);

      const res = await app.request(
        `${baseUrl}/sched-1/runs?limit=10&offset=5`,
      );
      expect(res.status).toBe(200);
    });
  });
});
