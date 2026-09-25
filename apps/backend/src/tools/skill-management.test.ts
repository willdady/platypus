import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";
import { callTool, resetMockDb, seedDb } from "../test-utils.ts";

// The write rules (conflict target, reference check, visibility re-check) are
// unit-tested in services/skill.test.ts; here the write model is a seam and
// the reads run against a seeded fake, so the Workspace scoping is real.
vi.mock("../services/skill.ts", () => ({
  upsertSkill: vi.fn(),
  deleteSkill: vi.fn(),
}));

import { createSkillManagementTools } from "./skill-management.ts";
import { deleteSkill, upsertSkill } from "../services/skill.ts";
import { ConflictError, LockedError, NotFoundError } from "../errors.ts";

const workspaceId = "ws-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";
const ctx = { orgId, workspaceId };
const validBody =
  "This is the skill body content that should be long enough to pass validation";

const skill = (
  id: string,
  scope: { workspaceId?: string; organizationId?: string },
) => ({
  id,
  name: `${id}-skill`,
  description: `${id} description`,
  body: `${id} body`,
  workspaceId: scope.workspaceId ?? null,
  organizationId: scope.organizationId ?? null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
});

const attached = (resourceId: string, ws = workspaceId) => ({
  id: `att-${resourceId}-${ws}`,
  workspaceId: ws,
  resourceType: "skill",
  resourceId,
});

describe("createSkillManagementTools", () => {
  let tools: ReturnType<typeof createSkillManagementTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    seedDb({
      skill: [
        skill("mine", { workspaceId }),
        skill("shared", { organizationId: orgId }),
        skill("unattached", { organizationId: orgId }),
        skill("elsewhere", { workspaceId: "ws-2" }),
      ],
      attachment: [attached("shared"), attached("unattached", "ws-2")],
    });
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

  it("listSkills returns this workspace's skills and the Shared skills attached here, without bodies", async () => {
    expect(await callTool(tools.listSkills, {})).toEqual([
      {
        id: "mine",
        name: "mine-skill",
        description: "mine description",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
        scope: "workspace",
      },
      expect.objectContaining({ id: "shared", scope: "organization" }),
    ]);
  });

  describe("getSkill", () => {
    it("returns a workspace skill with its scope and link", async () => {
      expect(await callTool(tools.getSkill, { name: "mine-skill" })).toEqual({
        ...skill("mine", { workspaceId }),
        scope: "workspace",
        url: "http://localhost:3000/org-1/workspace/ws-1/skills/mine",
      });
    });

    it("returns a Shared skill attached to this workspace", async () => {
      expect(
        await callTool(tools.getSkill, { name: "shared-skill" }),
      ).toMatchObject({ id: "shared", scope: "organization" });
    });

    it.each(["unattached-skill", "elsewhere-skill", "missing-skill"])(
      "does not find %s",
      async (name) => {
        expect(await callTool(tools.getSkill, { name })).toEqual({
          error: "Skill not found",
        });
      },
    );
  });

  describe("upsertSkill", () => {
    it("writes through the write model at this workspace and links the row", async () => {
      vi.mocked(upsertSkill).mockResolvedValueOnce({
        id: "s1",
        name: "my-skill",
      } as never);
      const input = {
        name: "my-skill",
        description: "A skill for testing purposes",
        body: validBody,
      };

      expect(await callTool(tools.upsertSkill, input)).toEqual({
        id: "s1",
        name: "my-skill",
        url: "http://localhost:3000/org-1/workspace/ws-1/skills/s1",
      });
      expect(upsertSkill).toHaveBeenCalledWith(ctx, input);
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
    it("deletes a workspace skill by its id at workspace scope", async () => {
      vi.mocked(deleteSkill).mockResolvedValueOnce();

      expect(await callTool(tools.deleteSkill, { name: "mine-skill" })).toEqual(
        { success: true },
      );
      expect(deleteSkill).toHaveBeenCalledWith(
        { kind: "workspace", ctx },
        "mine",
      );
    });

    it.each(["unattached-skill", "elsewhere-skill", "missing-skill"])(
      "does not find %s",
      async (name) => {
        expect(await callTool(tools.deleteSkill, { name })).toEqual({
          error: "Skill not found",
        });
        expect(deleteSkill).not.toHaveBeenCalled();
      },
    );

    it("refuses an attached Shared skill without reaching the write model", async () => {
      expect(
        await callTool(tools.deleteSkill, { name: "shared-skill" }),
      ).toEqual({ error: "This skill is managed at the organization level" });
      expect(deleteSkill).not.toHaveBeenCalled();
    });

    it.each([
      new ConflictError(
        "Cannot delete skill because it is referenced by one or more agents",
      ),
      // Visibility changed between the name lookup and the write.
      new NotFoundError("Skill not found"),
      new LockedError("This skill is managed at the organization level"),
    ])("reports the write model's $name as an error result", async (error) => {
      vi.mocked(deleteSkill).mockRejectedValueOnce(error);

      expect(await callTool(tools.deleteSkill, { name: "mine-skill" })).toEqual(
        { error: error.message },
      );
    });

    it("lets any other failure throw", async () => {
      vi.mocked(deleteSkill).mockRejectedValueOnce(
        new Error("connection lost"),
      );

      await expect(
        callTool(tools.deleteSkill, { name: "mine-skill" }),
      ).rejects.toThrow("connection lost");
    });
  });
});
