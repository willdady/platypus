import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

vi.mock("./sub-agent-validation.ts", () => ({
  validateSubAgentAssignment: vi.fn().mockResolvedValue({ valid: true }),
}));

// deleteAgent's avatar cleanup goes through avatar.ts's own getStorage() call,
// not one agent.ts makes directly — mocked here so that cleanup is a no-op.
vi.mock("../storage/index.ts", () => ({
  getStorage: vi.fn(() => ({
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { createAgent, updateAgent, deleteAgent } from "./agent.ts";
import { validateSubAgentAssignment } from "./sub-agent-validation.ts";
import { LockedError, NotFoundError } from "../errors.ts";

const ctx = { orgId: "org-1", workspaceId: "ws-1" };

describe("agent module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    vi.mocked(validateSubAgentAssignment).mockResolvedValue({ valid: true });
  });

  describe("createAgent", () => {
    it("inserts a workspace-scoped agent with a generated id", async () => {
      const inserted = { id: "a1", workspaceId: "ws-1", name: "New Agent" };
      mockDb.returning.mockResolvedValueOnce([inserted]);

      const result = await createAgent(ctx, {
        name: "New Agent",
        description: "desc",
        providerId: "p1",
        modelId: "m1",
      });

      expect(result).toEqual({ row: inserted });
      expect(mockDb.insert).toHaveBeenCalled();
      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.workspaceId).toBe("ws-1");
      expect(values.organizationId).toBeNull();
      expect(typeof values.id).toBe("string");
    });

    it("dedupes toolSetIds, skillIds and subAgentIds before insert", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "a1" }]);

      await createAgent(ctx, {
        name: "New Agent",
        description: "desc",
        providerId: "p1",
        modelId: "m1",
        toolSetIds: ["t1", "t1"],
        skillIds: ["s1", "s1"],
        subAgentIds: ["sub1", "sub1"],
      });

      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.toolSetIds).toEqual(["t1"]);
      expect(values.skillIds).toEqual(["s1"]);
      expect(values.subAgentIds).toEqual(["sub1"]);
    });

    it("returns an error and does not insert when sub-agent validation fails", async () => {
      vi.mocked(validateSubAgentAssignment).mockResolvedValueOnce({
        valid: false,
        error: "One or more sub-agents are not available in this workspace",
      });

      const result = await createAgent(ctx, {
        name: "New Agent",
        description: "desc",
        providerId: "p1",
        modelId: "m1",
        subAgentIds: ["missing"],
      });

      expect(result).toEqual({
        error: "One or more sub-agents are not available in this workspace",
      });
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("updateAgent", () => {
    it("updates a workspace-scoped agent", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "a1", workspaceId: "ws-1" }]);
      const updated = { id: "a1", workspaceId: "ws-1", name: "Renamed" };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await updateAgent(ctx, "a1", { name: "Renamed" });

      expect(result).toEqual({ row: updated });
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Renamed" }),
      );
    });

    it("persists a cleared sampling param as null (#263)", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "a1", workspaceId: "ws-1" }]);
      mockDb.returning.mockResolvedValueOnce([{ id: "a1", temperature: null }]);

      await updateAgent(ctx, "a1", { temperature: null });

      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: null }),
      );
    });

    it("throws NotFoundError when the agent is not visible here", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(updateAgent(ctx, "missing", { name: "x" })).rejects.toThrow(
        NotFoundError,
      );
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("throws LockedError for an attached Shared agent", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "a1", organizationId: "org-1", workspaceId: null },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]);

      await expect(updateAgent(ctx, "a1", { name: "x" })).rejects.toThrow(
        LockedError,
      );
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("returns an error and does not update when sub-agent validation fails", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "a1", workspaceId: "ws-1" }]);
      vi.mocked(validateSubAgentAssignment).mockResolvedValueOnce({
        valid: false,
        error: "An agent cannot assign itself as a sub-agent",
      });

      const result = await updateAgent(ctx, "a1", { subAgentIds: ["a1"] });

      expect(result).toEqual({
        error: "An agent cannot assign itself as a sub-agent",
      });
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("dedupes id arrays before validating and updating", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "a1", workspaceId: "ws-1" }]);
      mockDb.returning.mockResolvedValueOnce([{ id: "a1" }]);

      await updateAgent(ctx, "a1", { subAgentIds: ["sub1", "sub1"] });

      expect(validateSubAgentAssignment).toHaveBeenCalledWith(ctx, "a1", [
        "sub1",
      ]);
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ subAgentIds: ["sub1"] }),
      );
    });
  });

  describe("deleteAgent", () => {
    it("deletes a workspace-scoped agent and cleans up its avatar", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "a1", workspaceId: "ws-1", avatarKey: "agents/a1/avatar.webp" },
      ]);

      await deleteAgent(ctx, "a1");

      expect(mockDb.delete).toHaveBeenCalled();
    });

    it("deletes an agent with no avatar", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { id: "a1", workspaceId: "ws-1", avatarKey: null },
      ]);

      await deleteAgent(ctx, "a1");

      expect(mockDb.delete).toHaveBeenCalled();
    });

    it("throws NotFoundError when the agent is not visible here", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(deleteAgent(ctx, "missing")).rejects.toThrow(NotFoundError);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("throws LockedError for an attached Shared agent", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { id: "a1", organizationId: "org-1", workspaceId: null },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]);

      await expect(deleteAgent(ctx, "a1")).rejects.toThrow(LockedError);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });
  });
});
