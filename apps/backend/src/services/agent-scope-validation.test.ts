import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import { findNonSharedReferences } from "./agent-scope-validation.ts";
import { SANDBOX_TOOLSET_ID } from "../tools/index.ts";

const orgId = "org-1";

describe("findNonSharedReferences (no-cascade rule)", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  it("returns no blockers when every reference is org-scoped", async () => {
    // Query order: provider, skills, sub-agents, MCPs.
    mockDb.where
      .mockResolvedValueOnce([{ id: "p1", name: "P", organizationId: orgId }])
      .mockResolvedValueOnce([{ id: "s1", name: "S", organizationId: orgId }])
      .mockResolvedValueOnce([{ id: "a1", name: "A", organizationId: orgId }])
      .mockResolvedValueOnce([
        { id: "mcp1", name: "M", organizationId: orgId },
      ]);

    const blockers = await findNonSharedReferences(orgId, {
      providerId: "p1",
      skillIds: ["s1"],
      subAgentIds: ["a1"],
      toolSetIds: ["mcp1"],
    });

    expect(blockers).toEqual([]);
  });

  it("flags every workspace-private reference as a blocker", async () => {
    mockDb.where
      .mockResolvedValueOnce([
        { id: "p1", name: "WS Provider", organizationId: null },
      ])
      .mockResolvedValueOnce([
        { id: "s1", name: "WS Skill", organizationId: null },
      ])
      .mockResolvedValueOnce([
        { id: "a1", name: "WS Agent", organizationId: null },
      ])
      .mockResolvedValueOnce([
        { id: "mcp1", name: "WS Mcp", organizationId: null },
      ]);

    const blockers = await findNonSharedReferences(orgId, {
      providerId: "p1",
      skillIds: ["s1"],
      subAgentIds: ["a1"],
      toolSetIds: ["mcp1"],
    });

    expect(blockers).toEqual([
      { type: "provider", id: "p1", name: "WS Provider" },
      { type: "skill", id: "s1", name: "WS Skill" },
      { type: "subAgent", id: "a1", name: "WS Agent" },
      { type: "mcp", id: "mcp1", name: "WS Mcp" },
    ]);
  });

  it("treats statically-registered tool sets (incl. Sandbox) as always allowed", async () => {
    // Only the provider is queried; the Sandbox/static tool set never hits the
    // MCP table because it is registered, so no MCP lookup runs.
    mockDb.where.mockResolvedValueOnce([
      { id: "p1", name: "Shared Provider", organizationId: orgId },
    ]);

    const blockers = await findNonSharedReferences(orgId, {
      providerId: "p1",
      toolSetIds: [SANDBOX_TOOLSET_ID],
    });

    expect(blockers).toEqual([]);
  });

  it("flags a missing reference using its id as the name fallback", async () => {
    mockDb.where
      .mockResolvedValueOnce([{ id: "p1", name: "P", organizationId: orgId }])
      .mockResolvedValueOnce([]); // skill 'ghost' does not exist

    const blockers = await findNonSharedReferences(orgId, {
      providerId: "p1",
      skillIds: ["ghost"],
    });

    expect(blockers).toEqual([{ type: "skill", id: "ghost", name: "ghost" }]);
  });
});
