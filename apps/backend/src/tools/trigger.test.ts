import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

vi.mock("../utils/cron.ts", () => ({
  validateCronExpression: vi.fn((expr: string) => {
    if (expr === "invalid") return null;
    return new Date("2026-01-01T10:00:00Z");
  }),
}));

import { createTriggerTools } from "./trigger.ts";

const ctx = { toolCallId: "test", messages: [], context: {} };
const workspaceId = "ws-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";

type TriggerResult = {
  success?: boolean;
  error?: string;
  trigger?: unknown;
  url?: string;
};

describe("createTriggerTools", () => {
  let tools: ReturnType<typeof createTriggerTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    tools = createTriggerTools(workspaceId, orgId, frontendUrl);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "listAgents",
      "listTriggers",
      "getTrigger",
      "upsertTrigger",
      "deleteTrigger",
    ]);
  });

  describe("listAgents", () => {
    it("returns workspace agents and the Shared agents attached here", async () => {
      mockDb.where
        .mockResolvedValueOnce([
          {
            id: "a1",
            name: "Agent 1",
            description: "desc",
            createdAt: new Date("2024-01-01"),
          },
        ])
        // attached Shared agents arrive from an inner join, keyed by table name.
        .mockResolvedValueOnce([
          {
            agent: {
              id: "a2",
              name: "Shared Agent",
              description: "shared",
              createdAt: new Date("2024-02-01"),
            },
          },
        ]);

      expect(await tools.listAgents.execute!({}, ctx)).toEqual({
        // Newest first, across both scopes.
        agents: [
          { id: "a2", name: "Shared Agent", description: "shared" },
          { id: "a1", name: "Agent 1", description: "desc" },
        ],
        count: 2,
      });
    });
  });

  describe("listTriggers", () => {
    it("returns all triggers by default", async () => {
      const triggers = [{ id: "t1", name: "Trigger 1" }];
      mockDb.orderBy.mockResolvedValue(triggers);

      expect(
        await tools.listTriggers.execute!({ enabledOnly: false }, ctx),
      ).toEqual({ triggers, count: 1 });
    });
  });

  describe("getTrigger", () => {
    it("returns full trigger details", async () => {
      const trigger = {
        id: "t1",
        name: "Trigger 1",
        instruction: "Do something",
        config: { cronExpression: "0 9 * * *", timezone: "UTC" },
      };
      mockDb.limit.mockResolvedValue([trigger]);

      expect(await tools.getTrigger.execute!({ triggerId: "t1" }, ctx)).toEqual(
        { trigger },
      );
    });

    it("returns error when trigger not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = (await tools.getTrigger.execute!(
        { triggerId: "bad-id" },
        ctx,
      )) as TriggerResult;
      expect(result).toHaveProperty("error");
      expect(result.error).toContain("Trigger not found");
    });
  });

  describe("upsertTrigger", () => {
    it("returns error when required fields missing for create", async () => {
      const result = (await tools.upsertTrigger.execute!(
        { label: "test" },
        ctx,
      )) as TriggerResult;
      expect(result).toHaveProperty("error");
      expect(result.error).toContain("required");
    });

    it("creates a cron trigger when all fields provided", async () => {
      const trigger = {
        id: "t1",
        name: "Daily",
        type: "cron",
        config: { cronExpression: "0 9 * * *", timezone: "UTC" },
      };
      // Agent exists check
      mockDb.limit.mockResolvedValue([{ id: "a1", workspaceId }]);
      // Insert returning
      mockDb.returning.mockResolvedValue([trigger]);

      const result = (await tools.upsertTrigger.execute!(
        {
          label: "Daily",
          name: "Daily",
          agentId: "a1",
          instruction: "Run daily",
          type: "cron",
          config: { cronExpression: "0 9 * * *" },
        },
        ctx,
      )) as TriggerResult;

      expect(result.success).toBe(true);
      expect(result.trigger).toEqual(trigger);
      expect(result.url).toContain("triggers/");
    });

    it("returns error for invalid cron expression", async () => {
      mockDb.limit.mockResolvedValue([{ id: "a1", workspaceId }]);

      const result = (await tools.upsertTrigger.execute!(
        {
          label: "Bad",
          name: "Bad",
          agentId: "a1",
          instruction: "Run",
          type: "cron",
          config: { cronExpression: "invalid" },
        },
        ctx,
      )) as TriggerResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid cron");
    });

    it("creates an event trigger", async () => {
      const trigger = {
        id: "t2",
        name: "On Card",
        type: "event",
        config: { events: ["card.created"] },
      };
      mockDb.limit.mockResolvedValue([{ id: "a1", workspaceId }]);
      mockDb.returning.mockResolvedValue([trigger]);

      const result = (await tools.upsertTrigger.execute!(
        {
          label: "On Card",
          name: "On Card",
          agentId: "a1",
          instruction: "Handle card",
          type: "event",
          config: { events: ["card.created"] },
        },
        ctx,
      )) as TriggerResult;

      expect(result.success).toBe(true);
    });

    it("returns error for event trigger without events", async () => {
      mockDb.limit.mockResolvedValue([{ id: "a1", workspaceId }]);

      const result = (await tools.upsertTrigger.execute!(
        {
          label: "Bad Event",
          name: "Bad Event",
          agentId: "a1",
          instruction: "Handle",
          type: "event",
          config: { events: [] },
        },
        ctx,
      )) as TriggerResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("events");
    });

    it("returns error when agent not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = (await tools.upsertTrigger.execute!(
        {
          label: "Test",
          name: "Test",
          agentId: "nonexistent",
          instruction: "Do something",
          type: "cron",
          config: { cronExpression: "0 9 * * *" },
        },
        ctx,
      )) as TriggerResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Agent not found");
    });

    it("accepts a Shared agent attached to this workspace", async () => {
      const trigger = { id: "t3", name: "Shared", type: "cron" };
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "a2", organizationId: orgId, workspaceId: null },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]); // attached → usable here
      mockDb.returning.mockResolvedValue([trigger]);

      const result = (await tools.upsertTrigger.execute!(
        {
          label: "Shared",
          name: "Shared",
          agentId: "a2",
          instruction: "Run daily",
          type: "cron",
          config: { cronExpression: "0 9 * * *" },
        },
        ctx,
      )) as TriggerResult;

      expect(result.success).toBe(true);
    });

    it("returns error for invalid trigger type", async () => {
      mockDb.limit.mockResolvedValue([{ id: "a1", workspaceId }]);

      const result = (await tools.upsertTrigger.execute!(
        {
          label: "Bad",
          name: "Bad",
          agentId: "a1",
          instruction: "Do something",
          type: "invalid" as never,
          config: {},
        },
        ctx,
      )) as TriggerResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid trigger type");
    });

    it("returns error when trigger not found during update", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = (await tools.upsertTrigger.execute!(
        { triggerId: "bad-id", label: "test" },
        ctx,
      )) as TriggerResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Trigger not found");
    });
  });

  describe("deleteTrigger", () => {
    it("deletes a trigger", async () => {
      mockDb.returning.mockResolvedValue([{ id: "t1" }]);

      expect(
        await tools.deleteTrigger.execute!(
          { triggerId: "t1", label: "test" },
          ctx,
        ),
      ).toEqual({ success: true });
    });

    it("returns error when trigger not found", async () => {
      mockDb.returning.mockResolvedValue([]);

      expect(
        await tools.deleteTrigger.execute!(
          { triggerId: "bad-id", label: "test" },
          ctx,
        ),
      ).toEqual({ error: "Trigger not found" });
    });
  });
});
