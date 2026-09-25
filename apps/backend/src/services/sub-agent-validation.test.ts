import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";
import { validateSubAgentAssignment } from "./sub-agent-validation.ts";

const ctx = { orgId: "org-1", workspaceId: "ws-1" };

const agent = (
  id: string,
  workspaceId: string | null,
  organizationId: string | null,
): Row => ({ id, workspaceId, organizationId });

/**
 * `agent-2`/`agent-3` are ws-1's own; `shared` is org-1's and attached to ws-1;
 * `loose` is org-1's but unattached; `other-ws` is ws-2's; `foreign` is org-2's
 * and (pathologically) attached to ws-1.
 */
const world = () =>
  seedDb({
    agent: [
      agent("agent-1", "ws-1", null),
      agent("agent-2", "ws-1", null),
      agent("agent-3", "ws-1", null),
      agent("shared", null, "org-1"),
      agent("loose", null, "org-1"),
      agent("other-ws", "ws-2", null),
      agent("foreign", null, "org-2"),
    ],
    attachment: ["shared", "foreign"].map((id) => ({
      id: `att-${id}`,
      workspaceId: "ws-1",
      resourceType: "agent",
      resourceId: id,
    })),
  });

const UNAVAILABLE = {
  valid: false,
  error: "One or more sub-agents are not available in this workspace",
};

describe("validateSubAgentAssignment", () => {
  beforeEach(() => {
    resetMockDb();
  });

  it("returns invalid when agentId is in subAgentIds (self-assignment)", async () => {
    world();
    const result = await validateSubAgentAssignment(ctx, "agent-1", [
      "agent-2",
      "agent-1",
    ]);
    expect(result).toEqual({
      valid: false,
      error: "An agent cannot assign itself as a sub-agent",
    });
  });

  it.each([
    ["one workspace-scoped sub-agent", ["agent-2"]],
    ["several workspace-scoped sub-agents", ["agent-2", "agent-3"]],
    ["a Shared sub-agent attached here", ["shared"]],
    ["a mix of both", ["agent-3", "shared"]],
  ])("accepts %s", async (_label, ids) => {
    world();
    await expect(
      validateSubAgentAssignment(ctx, "agent-1", ids),
    ).resolves.toEqual({ valid: true });
  });

  it.each([
    ["an unknown id", ["agent-2", "gone"]],
    ["another workspace's agent", ["agent-2", "other-ws"]],
    ["a Shared agent not attached here", ["loose"]],
    ["another organization's agent", ["foreign"]],
  ])("rejects %s", async (_label, ids) => {
    world();
    await expect(
      validateSubAgentAssignment(ctx, "agent-1", ids),
    ).resolves.toEqual(UNAVAILABLE);
  });

  it("returns valid for empty subAgentIds array without querying", async () => {
    const fake = world();
    const select = vi.spyOn(
      fake.handle as { select: (...args: unknown[]) => unknown },
      "select",
    );

    const result = await validateSubAgentAssignment(ctx, "agent-1", []);

    expect(result).toEqual({ valid: true });
    expect(select).not.toHaveBeenCalled();
  });
});
