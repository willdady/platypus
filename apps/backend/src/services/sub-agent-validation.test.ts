import { describe, it, expect, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import { validateSubAgentAssignment } from "./sub-agent-validation.ts";

describe("validateSubAgentAssignment", () => {
  beforeEach(() => {
    resetMockDb();
  });

  it("returns invalid when agentId is in subAgentIds (self-assignment)", async () => {
    const result = await validateSubAgentAssignment("workspace-1", "agent-1", [
      "agent-2",
      "agent-1",
    ]);
    expect(result).toEqual({
      valid: false,
      error: "An agent cannot assign itself as a sub-agent",
    });
  });

  it("returns invalid when DB returns fewer agents than requested", async () => {
    mockDb.where.mockResolvedValueOnce([{ id: "agent-2" }]);
    const result = await validateSubAgentAssignment("workspace-1", "agent-1", [
      "agent-2",
      "agent-3",
    ]);
    expect(result).toEqual({
      valid: false,
      error: "One or more sub-agents not found in workspace",
    });
  });

  it("returns invalid when DB returns empty array (all agents missing)", async () => {
    mockDb.where.mockResolvedValueOnce([]);
    const result = await validateSubAgentAssignment("workspace-1", "agent-1", [
      "agent-2",
      "agent-3",
    ]);
    expect(result).toEqual({
      valid: false,
      error: "One or more sub-agents not found in workspace",
    });
  });

  it("returns valid when all sub-agents found (happy path)", async () => {
    mockDb.where.mockResolvedValueOnce([{ id: "agent-2" }, { id: "agent-3" }]);
    const result = await validateSubAgentAssignment("workspace-1", "agent-1", [
      "agent-2",
      "agent-3",
    ]);
    expect(result).toEqual({ valid: true });
  });

  it("returns valid for single sub-agent", async () => {
    mockDb.where.mockResolvedValueOnce([{ id: "agent-2" }]);
    const result = await validateSubAgentAssignment("workspace-1", "agent-1", [
      "agent-2",
    ]);
    expect(result).toEqual({ valid: true });
  });

  it("returns valid for empty subAgentIds array", async () => {
    mockDb.where.mockResolvedValueOnce([]);
    const result = await validateSubAgentAssignment(
      "workspace-1",
      "agent-1",
      [],
    );
    expect(result).toEqual({ valid: true });
  });
});
