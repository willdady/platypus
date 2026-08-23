import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";
import { mockDb, resetMockDb } from "../test-utils.ts";

import { createSkillManagementTools } from "./skill-management.ts";

const ctx = { toolCallId: "test", messages: [], context: {} };
const workspaceId = "ws-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";
const validBody =
  "This is the skill body content that should be long enough to pass validation";

describe("createSkillManagementTools", () => {
  let tools: ReturnType<typeof createSkillManagementTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    tools = createSkillManagementTools(workspaceId, orgId, frontendUrl);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "listSkills",
      "getSkill",
      "upsertSkill",
      "deleteSkill",
    ]);
  });

  describe("listSkills", () => {
    it("returns workspace skills and the Shared skills attached here", async () => {
      mockDb.where
        .mockResolvedValueOnce([{ id: "s1", name: "my-skill" }])
        // attached Shared skills arrive from an inner join, keyed by table name.
        .mockResolvedValueOnce([{ skill: { id: "s2", name: "shared-skill" } }]);

      expect(await tools.listSkills.execute!({}, ctx)).toEqual([
        expect.objectContaining({ id: "s1", scope: "workspace" }),
        expect.objectContaining({ id: "s2", scope: "organization" }),
      ]);
    });
  });

  describe("getSkill", () => {
    it("returns error when skill not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      expect(
        await tools.getSkill.execute!({ name: "nonexistent" }, ctx),
      ).toEqual({ error: "Skill not found" });
    });

    it("returns skill details when found", async () => {
      const skill = { id: "s1", name: "my-skill", body: "content" };
      mockDb.limit.mockResolvedValue([skill]);

      const result = (await tools.getSkill.execute!(
        { name: "my-skill" },
        ctx,
      )) as { name: string; url?: string };

      expect(result).toMatchObject({ name: "my-skill" });
      expect(result.url).toContain("skills/s1");
    });

    it("returns a Shared skill attached to this workspace", async () => {
      mockDb.limit
        .mockResolvedValueOnce([]) // no workspace-scoped skill of this name
        .mockResolvedValueOnce([
          { id: "s2", name: "shared-skill", organizationId: orgId },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]); // attached here

      expect(
        await tools.getSkill.execute!({ name: "shared-skill" }, ctx),
      ).toMatchObject({ name: "shared-skill", scope: "organization" });
    });
  });

  describe("upsertSkill", () => {
    it("creates or updates a skill via upsert", async () => {
      const skill = { id: "s1", name: "my-skill", body: "content" };
      mockDb.returning.mockResolvedValue([skill]);

      expect(
        await tools.upsertSkill.execute!(
          {
            name: "my-skill",
            description: "A skill for testing purposes",
            body: validBody,
          },
          ctx,
        ),
      ).toMatchObject({ name: "my-skill" });
    });

    it("writes a workspace-scoped row, keyed on (workspaceId, name)", async () => {
      // The conflict target is what keeps the write Workspace-private: reusing
      // the name of an attached Shared Skill creates this Workspace's own
      // version rather than editing the Organization's row.
      mockDb.returning.mockResolvedValue([{ id: "s1", name: "my-skill" }]);

      await tools.upsertSkill.execute!(
        {
          name: "my-skill",
          description: "A skill for testing purposes",
          body: validBody,
        },
        ctx,
      );

      const values = mockDb.values.mock.calls[0][0] as Record<string, unknown>;
      expect(values.workspaceId).toBe(workspaceId);
      const conflict = mockDb.onConflictDoUpdate.mock.calls[0][0] as {
        target: unknown[];
      };
      expect(conflict.target).toHaveLength(2);
    });

    describe("description length", () => {
      const parse = (description: string) =>
        (tools.upsertSkill.inputSchema as z.ZodType).safeParse({
          name: "my-skill",
          description,
          body: validBody,
        });

      it.each([24, 129, 500, 1024])(
        "accepts a description of %i characters",
        (length) => {
          expect(parse("a".repeat(length)).success).toBe(true);
        },
      );

      it.each([23, 1025])(
        "rejects a description of %i characters",
        (length) => {
          expect(parse("a".repeat(length)).success).toBe(false);
        },
      );
    });
  });

  describe("deleteSkill", () => {
    it("returns error when skill not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      expect(
        await tools.deleteSkill.execute!({ name: "nonexistent" }, ctx),
      ).toEqual({ error: "Skill not found" });
    });

    it("returns error when skill is referenced by agents", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "s1" }]); // name → workspace skill
      mockDb.limit.mockResolvedValueOnce([{ id: "s1", workspaceId }]); // write model re-checks visibility
      mockDb.limit.mockResolvedValueOnce([{ id: "a1" }]); // referencing agents

      const result = (await tools.deleteSkill.execute!(
        { name: "referenced-skill" },
        ctx,
      )) as { error?: string };

      expect(result.error).toContain("referenced by one or more agents");
    });

    it("refuses to delete a Shared skill", async () => {
      mockDb.limit
        .mockResolvedValueOnce([]) // no workspace-scoped skill of this name
        .mockResolvedValueOnce([
          { id: "s2", name: "shared-skill", organizationId: orgId },
        ])
        .mockResolvedValueOnce([{ id: "att-1" }]); // attached here

      const result = (await tools.deleteSkill.execute!(
        { name: "shared-skill" },
        ctx,
      )) as { error?: string };

      expect(result.error).toContain("managed at the organization level");
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("deletes skill when no agents reference it", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "s1" }]); // name → workspace skill
      mockDb.limit.mockResolvedValueOnce([{ id: "s1", workspaceId }]); // write model re-checks visibility
      mockDb.limit.mockResolvedValueOnce([]); // referencing agents: none

      expect(
        await tools.deleteSkill.execute!({ name: "unused-skill" }, ctx),
      ).toEqual({ success: true });
      expect(mockDb.delete).toHaveBeenCalled();
    });
  });
});
