import { describe, it, expect, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import { validateSubAgentAssignment } from "./sub-agent-validation.ts";

const ctx = { orgId: "org-1", wsId: "workspace-1" };

/**
 * Stubs the two queries `listScoped` runs: the Workspace-scoped rows, then the
 * Organization-scoped rows inner-joined to this Workspace's Attachments (keyed
 * by table name in a join result).
 */
const stubVisibleAgents = (
  workspaceAgentIds: string[],
  attachedOrgAgentIds: string[] = [],
) => {
  mockDb.where.mockResolvedValueOnce(
    workspaceAgentIds.map((id) => ({ id, workspaceId: "workspace-1" })),
  );
  mockDb.where.mockResolvedValueOnce(
    attachedOrgAgentIds.map((id) => ({
      agent: { id, organizationId: "org-1", workspaceId: null },
      attachment: { id: `att-${id}` },
    })),
  );
};

describe("validateSubAgentAssignment", () => {
  beforeEach(() => {
    resetMockDb();
  });

  it("returns invalid when agentId is in subAgentIds (self-assignment)", async () => {
    const result = await validateSubAgentAssignment(ctx, "agent-1", [
      "agent-2",
      "agent-1",
    ]);
    expect(result).toEqual({
      valid: false,
      error: "An agent cannot assign itself as a sub-agent",
    });
  });

  it("returns invalid when a sub-agent is not visible in the workspace", async () => {
    stubVisibleAgents(["agent-2"]);
    const result = await validateSubAgentAssignment(ctx, "agent-1", [
      "agent-2",
      "agent-3",
    ]);
    expect(result).toEqual({
      valid: false,
      error: "One or more sub-agents are not available in this workspace",
    });
  });

  it("returns invalid when no sub-agent is visible in the workspace", async () => {
    stubVisibleAgents([]);
    const result = await validateSubAgentAssignment(ctx, "agent-1", [
      "agent-2",
      "agent-3",
    ]);
    expect(result).toEqual({
      valid: false,
      error: "One or more sub-agents are not available in this workspace",
    });
  });

  it("returns valid when all sub-agents are workspace-scoped here (happy path)", async () => {
    stubVisibleAgents(["agent-2", "agent-3"]);
    const result = await validateSubAgentAssignment(ctx, "agent-1", [
      "agent-2",
      "agent-3",
    ]);
    expect(result).toEqual({ valid: true });
  });

  it("returns valid for a single sub-agent", async () => {
    stubVisibleAgents(["agent-2"]);
    const result = await validateSubAgentAssignment(ctx, "agent-1", [
      "agent-2",
    ]);
    expect(result).toEqual({ valid: true });
  });

  it("accepts an org-scoped (Shared) sub-agent attached to this workspace", async () => {
    stubVisibleAgents([], ["shared-agent"]);
    const result = await validateSubAgentAssignment(ctx, "agent-1", [
      "shared-agent",
    ]);
    expect(result).toEqual({ valid: true });
  });

  it("rejects an org-scoped sub-agent that is not attached to this workspace", async () => {
    stubVisibleAgents([], []);
    const result = await validateSubAgentAssignment(ctx, "agent-1", [
      "shared-agent",
    ]);
    expect(result).toEqual({
      valid: false,
      error: "One or more sub-agents are not available in this workspace",
    });
  });

  it("returns valid for empty subAgentIds array without querying", async () => {
    const result = await validateSubAgentAssignment(ctx, "agent-1", []);
    expect(result).toEqual({ valid: true });
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});
