import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, dbMethods } = vi.hoisted(() => {
  const mock: any = {};
  const methods = [
    "select",
    "from",
    "where",
    "innerJoin",
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

import { createLoadSkillTool } from "./skill.ts";

const ctx = { toolCallId: "test", messages: [] };

describe("createLoadSkillTool", () => {
  const orgId = "org-1";
  const workspaceId = "ws-1";
  let loadSkill: ReturnType<typeof createLoadSkillTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    dbMethods.forEach((method) => {
      mockDb[method] = vi.fn().mockReturnValue(mockDb);
    });
    loadSkill = createLoadSkillTool(orgId, workspaceId);
  });

  it("returns a tool with the correct description", () => {
    expect(loadSkill.description).toContain("skill");
  });

  it("returns workspace skill data when found", async () => {
    const skillData = { name: "my-skill", body: "Skill instructions here" };
    // First query (workspace-scoped) resolves with the skill.
    mockDb.limit.mockResolvedValueOnce([skillData]);

    const result = await loadSkill.execute({ name: "my-skill" }, ctx);
    expect(result).toEqual({
      name: "my-skill",
      body: "Skill instructions here",
    });
  });

  it("falls back to an attached org-scoped skill", async () => {
    const orgSkill = { name: "shared-skill", body: "Shared instructions" };
    // Workspace query empty, then the attached org-scoped query resolves.
    mockDb.limit.mockResolvedValueOnce([]).mockResolvedValueOnce([orgSkill]);

    const result = await loadSkill.execute({ name: "shared-skill" }, ctx);
    expect(result).toEqual(orgSkill);
  });

  it("returns error when skill not found at either scope", async () => {
    mockDb.limit.mockResolvedValue([]);

    const result = await loadSkill.execute({ name: "nonexistent" }, ctx);
    expect(result).toEqual({ error: "Skill 'nonexistent' not found" });
  });
});
