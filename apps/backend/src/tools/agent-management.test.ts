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
    "onConflictDoUpdate",
  ];
  methods.forEach((method) => {
    mock[method] = vi.fn().mockReturnValue(mock);
  });
  return { mockDb: mock, dbMethods: methods };
});

vi.mock("../index.ts", () => ({
  db: mockDb,
}));

vi.mock("../services/sub-agent-validation.ts", () => ({
  validateSubAgentAssignment: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock("../storage/index.ts", () => ({
  getStorage: vi.fn(() => ({
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn(),
    and: vi.fn((...args) => args.filter(Boolean)),
  };
});

import { createAgentManagementTools } from "./agent-management.ts";
import { validateSubAgentAssignment } from "../services/sub-agent-validation.ts";

const ctx = { toolCallId: "test", messages: [] };
const workspaceId = "ws-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";

function resetDb() {
  dbMethods.forEach((method) => {
    mockDb[method] = vi.fn().mockReturnValue(mockDb);
  });
}

describe("createAgentManagementTools", () => {
  let tools: ReturnType<typeof createAgentManagementTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDb();
    tools = createAgentManagementTools(workspaceId, orgId, frontendUrl);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "createAgent",
      "updateAgent",
      "deleteAgent",
    ]);
  });

  describe("updateAgent", () => {
    it("returns error when agent not found", async () => {
      mockDb.returning.mockResolvedValue([]);

      const result = await tools.updateAgent.execute(
        { agentId: "bad-id", label: "test", name: "New Name" },
        ctx,
      );
      expect(result).toEqual({ error: "Agent not found" });
    });

    it("validates sub-agent assignments", async () => {
      vi.mocked(validateSubAgentAssignment).mockResolvedValueOnce({
        valid: false,
        error: "Circular dependency detected",
      });

      const result = await tools.updateAgent.execute(
        { agentId: "a1", label: "test", subAgentIds: ["a1"] },
        ctx,
      );

      expect(result).toEqual({ error: "Circular dependency detected" });
    });

    it("converts string[] subAgentIds into {id}[] before validation", async () => {
      vi.mocked(validateSubAgentAssignment).mockResolvedValueOnce({
        valid: true,
      });
      mockDb.returning.mockResolvedValueOnce([{ id: "a1" }]);

      await tools.updateAgent.execute(
        { agentId: "a1", label: "test", subAgentIds: ["sa-1", "sa-2"] },
        ctx,
      );

      expect(validateSubAgentAssignment).toHaveBeenCalledWith("ws-1", "a1", [
        { id: "sa-1" },
        { id: "sa-2" },
      ]);
    });

    it("deduplicates duplicate sub-agent ids before validation", async () => {
      vi.mocked(validateSubAgentAssignment).mockResolvedValueOnce({
        valid: true,
      });
      mockDb.returning.mockResolvedValueOnce([{ id: "a1" }]);

      await tools.updateAgent.execute(
        { agentId: "a1", label: "test", subAgentIds: ["sa-1", "sa-1", "sa-2"] },
        ctx,
      );

      expect(validateSubAgentAssignment).toHaveBeenCalledWith("ws-1", "a1", [
        { id: "sa-1" },
        { id: "sa-2" },
      ]);
    });

    it("writes converted {id}[] shape to the database", async () => {
      vi.mocked(validateSubAgentAssignment).mockResolvedValueOnce({
        valid: true,
      });
      mockDb.returning.mockResolvedValueOnce([{ id: "a1" }]);

      await tools.updateAgent.execute(
        { agentId: "a1", label: "test", subAgentIds: ["sa-1"] },
        ctx,
      );

      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          subAgentIds: [{ id: "sa-1" }],
        }),
      );
    });
  });

  describe("createAgent", () => {
    it("converts string[] subAgentIds into {id}[] before writing", async () => {
      vi.mocked(validateSubAgentAssignment).mockResolvedValueOnce({
        valid: true,
      });
      mockDb.returning.mockResolvedValueOnce([{ id: "new-id" }]);

      await tools.createAgent.execute(
        {
          name: "Coord",
          description: "test agent",
          providerId: "p1",
          modelId: "m1",
          subAgentIds: ["sa-1", "sa-1", "sa-2"],
        },
        ctx,
      );

      expect(validateSubAgentAssignment).toHaveBeenCalledWith(
        "ws-1",
        expect.any(String),
        [{ id: "sa-1" }, { id: "sa-2" }],
      );
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          subAgentIds: [{ id: "sa-1" }, { id: "sa-2" }],
        }),
      );
    });
  });

  describe("deleteAgent", () => {
    it("returns error when agent not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await tools.deleteAgent.execute(
        { agentId: "bad-id", label: "test" },
        ctx,
      );
      expect(result).toEqual({ error: "Agent not found" });
    });

    it("deletes agent and cleans up avatar", async () => {
      mockDb.limit.mockResolvedValue([{ avatarKey: "avatars/a1.png" }]);

      const result = await tools.deleteAgent.execute(
        { agentId: "a1", label: "Agent 1" },
        ctx,
      );
      expect(result).toEqual({ success: true });
    });

    it("deletes agent without avatar", async () => {
      mockDb.limit.mockResolvedValue([{ avatarKey: null }]);

      const result = await tools.deleteAgent.execute(
        { agentId: "a1", label: "Agent 1" },
        ctx,
      );
      expect(result).toEqual({ success: true });
    });
  });
});
