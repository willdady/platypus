import { describe, it, expect, beforeEach } from "vitest";
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";
import { findNonSharedReferences } from "./agent-scope-validation.ts";
import { SANDBOX_TOOLSET_ID } from "../tools/index.ts";

const orgId = "org-1";

/**
 * Per table: `shared-*` is Shared in org-1; `ws-*` is Workspace-private;
 * `foreign-*` is Shared in another Organization; `dual-*` carries a Workspace
 * as well as org-1 (the scope columns are mutually exclusive on write, not by a
 * database constraint, and such a row is workspace-private in every other
 * query).
 */
const rowsFor = (prefix: string): Row[] => [
  {
    id: `shared-${prefix}`,
    name: `Shared ${prefix}`,
    organizationId: orgId,
    workspaceId: null,
  },
  {
    id: `ws-${prefix}`,
    name: `WS ${prefix}`,
    organizationId: null,
    workspaceId: "ws-1",
  },
  {
    id: `foreign-${prefix}`,
    name: `Foreign ${prefix}`,
    organizationId: "org-2",
    workspaceId: null,
  },
  {
    id: `dual-${prefix}`,
    name: `Dual ${prefix}`,
    organizationId: orgId,
    workspaceId: "ws-1",
  },
];

describe("findNonSharedReferences (no-cascade rule)", () => {
  beforeEach(() => {
    resetMockDb();
    seedDb({
      provider: rowsFor("p"),
      skill: rowsFor("s"),
      agent: rowsFor("a"),
      mcp: rowsFor("m"),
    });
  });

  it("returns no blockers when every reference is Shared in this organization", async () => {
    const blockers = await findNonSharedReferences(orgId, {
      providerId: "shared-p",
      skillIds: ["shared-s"],
      subAgentIds: ["shared-a"],
      toolSetIds: ["shared-m"],
    });

    expect(blockers).toEqual([]);
  });

  it.each(["ws", "foreign", "dual"])(
    "flags every %s reference as a blocker, named by its row",
    async (kind) => {
      const blockers = await findNonSharedReferences(orgId, {
        providerId: `${kind}-p`,
        skillIds: ["shared-s", `${kind}-s`],
        subAgentIds: [`${kind}-a`, "shared-a"],
        toolSetIds: [`${kind}-m`],
      });

      const name = { ws: "WS", foreign: "Foreign", dual: "Dual" }[kind];
      expect(blockers).toEqual([
        { type: "provider", id: `${kind}-p`, name: `${name} p` },
        { type: "skill", id: `${kind}-s`, name: `${name} s` },
        { type: "subAgent", id: `${kind}-a`, name: `${name} a` },
        { type: "mcp", id: `${kind}-m`, name: `${name} m` },
      ]);
    },
  );

  it("flags missing references using their id as the name fallback", async () => {
    const blockers = await findNonSharedReferences(orgId, {
      providerId: "ghost-p",
      skillIds: ["ghost-s"],
      subAgentIds: ["ghost-a"],
      toolSetIds: ["ghost-m"],
    });

    expect(blockers).toEqual([
      { type: "provider", id: "ghost-p", name: "ghost-p" },
      { type: "skill", id: "ghost-s", name: "ghost-s" },
      { type: "subAgent", id: "ghost-a", name: "ghost-a" },
      { type: "mcp", id: "ghost-m", name: "ghost-m" },
    ]);
  });

  it("treats statically-registered tool sets (incl. Sandbox) as always allowed", async () => {
    const blockers = await findNonSharedReferences(orgId, {
      providerId: "shared-p",
      skillIds: null,
      toolSetIds: [SANDBOX_TOOLSET_ID],
    });

    expect(blockers).toEqual([]);
  });
});
