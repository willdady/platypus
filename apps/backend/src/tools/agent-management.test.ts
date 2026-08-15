import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

vi.mock("../services/sub-agent-validation.ts", () => ({
  validateSubAgentAssignment: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock("../storage/index.ts", () => ({
  getStorage: vi.fn(() => ({
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { createAgentManagementTools } from "./agent-management.ts";
import { validateSubAgentAssignment } from "../services/sub-agent-validation.ts";

const ctx = { toolCallId: "test", messages: [], context: {} };
const workspaceId = "ws-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";

describe("createAgentManagementTools", () => {
  let tools: ReturnType<typeof createAgentManagementTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
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

      expect(
        await tools.updateAgent.execute!(
          { agentId: "bad-id", label: "test", name: "New Name" },
          ctx,
        ),
      ).toEqual({ error: "Agent not found" });
    });

    it("refuses to update a Shared agent attached to this workspace", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "a1", organizationId: orgId, workspaceId: null },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]); // attached → visible, not writable

      const result = (await tools.updateAgent.execute!(
        { agentId: "a1", label: "test", name: "New Name" },
        ctx,
      )) as { error?: string };

      expect(result.error).toContain("managed at the organization level");
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("validates sub-agent assignments", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "a1", workspaceId }]);
      vi.mocked(validateSubAgentAssignment).mockResolvedValueOnce({
        valid: false,
        error: "Circular dependency detected",
      });

      expect(
        await tools.updateAgent.execute!(
          { agentId: "a1", label: "test", subAgentIds: ["a1"] },
          ctx,
        ),
      ).toEqual({ error: "Circular dependency detected" });
    });
  });

  describe("deleteAgent", () => {
    it("returns error when agent not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      expect(
        await tools.deleteAgent.execute!(
          { agentId: "bad-id", label: "test" },
          ctx,
        ),
      ).toEqual({ error: "Agent not found" });
    });

    it("refuses to delete a Shared agent attached to this workspace", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "a1", organizationId: orgId, workspaceId: null },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]); // attached → visible, not deletable

      const result = (await tools.deleteAgent.execute!(
        { agentId: "a1", label: "Agent 1" },
        ctx,
      )) as { error?: string };

      expect(result.error).toContain("managed at the organization level");
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("deletes agent and cleans up avatar", async () => {
      mockDb.limit.mockResolvedValue([
        { id: "a1", workspaceId, avatarKey: "avatars/a1.png" },
      ]);

      expect(
        await tools.deleteAgent.execute!(
          { agentId: "a1", label: "Agent 1" },
          ctx,
        ),
      ).toEqual({ success: true });
    });

    it("deletes agent without avatar", async () => {
      mockDb.limit.mockResolvedValue([
        { id: "a1", workspaceId, avatarKey: null },
      ]);

      expect(
        await tools.deleteAgent.execute!(
          { agentId: "a1", label: "Agent 1" },
          ctx,
        ),
      ).toEqual({ success: true });
    });
  });
});
