import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

import { createLoadSkillTool } from "./skill.ts";

const ctx = { toolCallId: "test", messages: [], context: {} };

describe("createLoadSkillTool", () => {
  const orgId = "org-1";
  const workspaceId = "ws-1";
  let loadSkill: ReturnType<typeof createLoadSkillTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    loadSkill = createLoadSkillTool(orgId, workspaceId);
  });

  it("returns a tool with the correct description", () => {
    expect(loadSkill.description).toContain("skill");
  });

  it("returns workspace skill data when found", async () => {
    const skillData = { name: "my-skill", body: "Skill instructions here" };
    // First query (workspace-scoped) resolves with the skill.
    mockDb.limit.mockResolvedValueOnce([skillData]);

    expect(await loadSkill.execute({ name: "my-skill" }, ctx)).toEqual({
      name: "my-skill",
      body: "Skill instructions here",
    });
  });

  it("falls back to an attached org-scoped skill", async () => {
    const orgSkill = {
      id: "s2",
      name: "shared-skill",
      body: "Shared instructions",
      organizationId: "org-1",
      workspaceId: null,
    };
    mockDb.limit
      .mockResolvedValueOnce([]) // no workspace-scoped skill of this name
      .mockResolvedValueOnce([orgSkill]) // the Shared skill
      .mockResolvedValueOnce([{ id: "att-1" }]); // attached to this workspace

    expect(await loadSkill.execute({ name: "shared-skill" }, ctx)).toEqual({
      name: "shared-skill",
      body: "Shared instructions",
    });
  });

  it("refuses an org-scoped skill that is not attached here", async () => {
    mockDb.limit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "s2",
          name: "shared-skill",
          body: "Shared instructions",
          organizationId: "org-1",
          workspaceId: null,
        },
      ])
      .mockResolvedValueOnce([]); // no attachment → not visible here

    expect(await loadSkill.execute({ name: "shared-skill" }, ctx)).toEqual({
      error: "Skill 'shared-skill' not found",
    });
  });

  it("returns error when skill not found at either scope", async () => {
    mockDb.limit.mockResolvedValue([]);

    expect(await loadSkill.execute({ name: "nonexistent" }, ctx)).toEqual({
      error: "Skill 'nonexistent' not found",
    });
  });
});
