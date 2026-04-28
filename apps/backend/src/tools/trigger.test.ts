import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, dbMethods } = vi.hoisted(() => {
  const mock: any = {};
  const methods = [
    "select",
    "from",
    "where",
    "limit",
    "orderBy",
    "insert",
    "values",
    "update",
    "set",
    "delete",
    "returning",
  ];
  methods.forEach((method) => {
    mock[method] = vi.fn().mockReturnValue(mock);
  });
  return { mockDb: mock, dbMethods: methods };
});

vi.mock("../index.ts", () => ({
  db: mockDb,
}));

vi.mock("../utils/cron.ts", () => ({
  validateCronExpression: vi.fn((expr: string) => {
    if (expr === "invalid") return null;
    return new Date("2026-01-01T10:00:00Z");
  }),
}));

import { createTriggerTools } from "./trigger.ts";

const ctx = { toolCallId: "test", messages: [] };
const workspaceId = "ws-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";

function resetDb() {
  dbMethods.forEach((method) => {
    mockDb[method] = vi.fn().mockReturnValue(mockDb);
  });
}

describe("createTriggerTools", () => {
  let tools: ReturnType<typeof createTriggerTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDb();
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
    it("returns agents in workspace", async () => {
      const agents = [{ id: "a1", name: "Agent 1", description: "desc" }];
      mockDb.orderBy.mockResolvedValue(agents);

      const result = await tools.listAgents.execute({}, ctx);
      expect(result).toEqual({ agents, count: 1 });
    });
  });

  describe("listTriggers", () => {
    it("returns all triggers by default", async () => {
      const triggers = [{ id: "t1", name: "Trigger 1" }];
      mockDb.orderBy.mockResolvedValue(triggers);

      const result = await tools.listTriggers.execute(
        { enabledOnly: false },
        ctx,
      );
      expect(result).toEqual({ triggers, count: 1 });
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

      const result = await tools.getTrigger.execute({ triggerId: "t1" }, ctx);
      expect(result).toEqual({ trigger });
    });

    it("returns error when trigger not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await tools.getTrigger.execute(
        { triggerId: "bad-id" },
        ctx,
      );
      expect(result).toHaveProperty("error");
      expect(result.error).toContain("Trigger not found");
    });
  });

  describe("upsertTrigger", () => {
    it("returns error when required fields missing for create", async () => {
      const result = await tools.upsertTrigger.execute({ label: "test" }, ctx);
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
      mockDb.limit.mockResolvedValue([{ id: "a1" }]);
      // Insert returning
      mockDb.returning.mockResolvedValue([trigger]);

      const result = await tools.upsertTrigger.execute(
        {
          label: "Daily",
          name: "Daily",
          agentId: "a1",
          instruction: "Run daily",
          type: "cron",
          config: { cronExpression: "0 9 * * *" },
        },
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.trigger).toEqual(trigger);
      expect(result.url).toContain("triggers/");
    });

    it("returns error for invalid cron expression", async () => {
      mockDb.limit.mockResolvedValue([{ id: "a1" }]);

      const result = await tools.upsertTrigger.execute(
        {
          label: "Bad",
          name: "Bad",
          agentId: "a1",
          instruction: "Run",
          type: "cron",
          config: { cronExpression: "invalid" },
        },
        ctx,
      );

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
      mockDb.limit.mockResolvedValue([{ id: "a1" }]);
      mockDb.returning.mockResolvedValue([trigger]);

      const result = await tools.upsertTrigger.execute(
        {
          label: "On Card",
          name: "On Card",
          agentId: "a1",
          instruction: "Handle card",
          type: "event",
          config: { events: ["card.created"] },
        },
        ctx,
      );

      expect(result.success).toBe(true);
    });

    it("returns error for event trigger without events", async () => {
      mockDb.limit.mockResolvedValue([{ id: "a1" }]);

      const result = await tools.upsertTrigger.execute(
        {
          label: "Bad Event",
          name: "Bad Event",
          agentId: "a1",
          instruction: "Handle",
          type: "event",
          config: { events: [] },
        },
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("events");
    });

    it("returns error when agent not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await tools.upsertTrigger.execute(
        {
          label: "Test",
          name: "Test",
          agentId: "nonexistent",
          instruction: "Do something",
          type: "cron",
          config: { cronExpression: "0 9 * * *" },
        },
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Agent not found");
    });

    it("returns error for invalid trigger type", async () => {
      mockDb.limit.mockResolvedValue([{ id: "a1" }]);

      const result = await tools.upsertTrigger.execute(
        {
          label: "Bad",
          name: "Bad",
          agentId: "a1",
          instruction: "Do something",
          type: "invalid" as any,
          config: {},
        },
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid trigger type");
    });

    it("returns error when trigger not found during update", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await tools.upsertTrigger.execute(
        { triggerId: "bad-id", label: "test" },
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Trigger not found");
    });
  });

  describe("deleteTrigger", () => {
    it("deletes a trigger", async () => {
      mockDb.returning.mockResolvedValue([{ id: "t1" }]);

      const result = await tools.deleteTrigger.execute(
        { triggerId: "t1", label: "test" },
        ctx,
      );
      expect(result).toEqual({ success: true });
    });

    it("returns error when trigger not found", async () => {
      mockDb.returning.mockResolvedValue([]);

      const result = await tools.deleteTrigger.execute(
        { triggerId: "bad-id", label: "test" },
        ctx,
      );
      expect(result).toEqual({ error: "Trigger not found" });
    });
  });
});
