import { describe, it, expect, beforeEach } from "vitest";
import { callTool, resetMockDb, seedDb } from "../test-utils.ts";

import { createLoadSkillTool } from "./skill.ts";

const orgId = "org-1";
const workspaceId = "ws-1";

const skill = (
  id: string,
  name: string,
  scope: { workspaceId?: string; organizationId?: string },
  over: Record<string, unknown> = {},
) => ({
  id,
  name,
  body: `${id} body`,
  workspaceId: scope.workspaceId ?? null,
  organizationId: scope.organizationId ?? null,
  disableModelInvocation: false,
  ...over,
});

const attached = (resourceId: string, ws = workspaceId) => ({
  id: `att-${resourceId}-${ws}`,
  workspaceId: ws,
  resourceType: "skill",
  resourceId,
});

describe("createLoadSkillTool", () => {
  beforeEach(() => {
    resetMockDb();
    seedDb({
      skill: [
        skill("ws-skill", "my-skill", { workspaceId }),
        skill("shared", "shared-skill", { organizationId: orgId }),
        skill("unattached", "unattached-skill", { organizationId: orgId }),
        skill("elsewhere", "elsewhere-skill", { workspaceId: "ws-2" }),
        skill("other-org", "other-org-skill", { organizationId: "org-2" }),
        // An unassigned workspace skill shadowing an assigned Shared one.
        skill("shadow", "shadowed", { workspaceId }),
        skill("shadowed-shared", "shadowed", { organizationId: orgId }),
        skill("unassigned", "unassigned-skill", { workspaceId }),
        skill(
          "human-only",
          "human-only",
          { workspaceId },
          { disableModelInvocation: true },
        ),
      ],
      attachment: [
        attached("shared"),
        attached("shadowed-shared"),
        attached("unattached", "ws-2"),
        attached("other-org"),
      ],
    });
  });

  const load = (name: string, permitted: string[]) =>
    callTool(createLoadSkillTool(orgId, workspaceId, permitted), { name });

  it.each([
    ["a workspace skill", "my-skill", "ws-skill"],
    ["an attached Shared skill", "shared-skill", "shared"],
    [
      "an assigned Shared skill shadowed by an unassigned workspace skill",
      "shadowed",
      "shadowed-shared",
    ],
  ])("loads %s", async (_label, name, id) => {
    expect(await load(name, [id])).toEqual({ name, body: `${id} body` });
  });

  it.each([
    ["a Shared skill attached only to another workspace", "unattached"],
    ["another workspace's skill", "elsewhere"],
    ["another organization's skill", "other-org"],
    ["a name that does not exist", "missing"],
  ])("does not find %s, even when assigned", async (_label, id) => {
    const name = `${id}-skill`;
    expect(await load(name, [id])).toEqual({
      error: `Skill '${name}' not found`,
    });
  });

  it("refuses a skill that is not assigned to the running Agent", async () => {
    expect(await load("unassigned-skill", ["ws-skill"])).toEqual({
      error: "Skill 'unassigned-skill' is not assigned to this agent",
    });
  });

  it("refuses a user-invocable-only skill from the model", async () => {
    expect(await load("human-only", ["human-only"])).toEqual({
      error: "Skill 'human-only' can only be invoked by a user",
    });
  });
});
