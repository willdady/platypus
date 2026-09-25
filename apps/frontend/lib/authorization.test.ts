// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  type Actor,
  canAccessOrganization,
  canAccessWorkspace,
  canConfigureSandbox,
  canConfigureWorkspaceResource,
  canCreateWorkspace,
  canListOrgMembers,
  canManageOrgSharedResource,
  canManageSharedResource,
  canManageWorkspaceDelegation,
  canSendChatMessages,
  isOperator,
  resolveActor,
} from "./authorization";

const ACTORS: Actor[] = [
  "operator",
  "org-admin",
  "workspace-owner",
  "org-member",
];

describe("resolveActor", () => {
  it.each([
    [
      "the Operator regardless of any other signal",
      { isOperator: true, orgRole: "member", ownsWorkspace: false },
      "operator",
    ],
    [
      "the Org Admin when not the Operator",
      { isOperator: false, orgRole: "admin", ownsWorkspace: false },
      "org-admin",
    ],
    [
      "the Workspace Owner when neither Operator nor Org Admin",
      { isOperator: false, orgRole: "member", ownsWorkspace: true },
      "workspace-owner",
    ],
    [
      "a plain Org member otherwise",
      { isOperator: false, orgRole: "member", ownsWorkspace: false },
      "org-member",
    ],
    [
      "a plain Org member outside any Organization",
      { isOperator: false, orgRole: null, ownsWorkspace: false },
      "org-member",
    ],
  ] as const)("names %s", (_name, input, expected) => {
    expect(resolveActor(input)).toBe(expected);
  });
});

describe("canManageSharedResource — attach/detach/Promote (ADR-0007)", () => {
  it.each(ACTORS)("%s outside a Workspace is refused", (actor) => {
    expect(canManageSharedResource(actor, undefined)).toBe(false);
  });

  it.each([
    ["operator", true],
    ["org-admin", true],
    // Even inside their own Workspace.
    ["workspace-owner", false],
    ["org-member", false],
  ] as const)("%s inside a Workspace: allowed=%s", (actor, allowed) => {
    expect(canManageSharedResource(actor, "ws-1")).toBe(allowed);
  });
});

describe("canConfigureWorkspaceResource — credential delegation (ADR-0006)", () => {
  for (const type of ["provider", "mcp"] as const) {
    it(`Operator always may configure a ${type}`, () => {
      expect(canConfigureWorkspaceResource("operator", type, false)).toBe(true);
    });

    it(`Org Admin always may configure a ${type}`, () => {
      expect(canConfigureWorkspaceResource("org-admin", type, false)).toBe(
        true,
      );
    });

    it(`Workspace Owner may configure a delegated ${type}`, () => {
      expect(canConfigureWorkspaceResource("workspace-owner", type, true)).toBe(
        true,
      );
    });

    it(`Workspace Owner may not configure a non-delegated ${type}`, () => {
      expect(
        canConfigureWorkspaceResource("workspace-owner", type, false),
      ).toBe(false);
    });

    it(`a plain Org member may never configure a ${type}`, () => {
      expect(canConfigureWorkspaceResource("org-member", type, true)).toBe(
        false,
      );
    });
  }

  it("a Sandbox is never delegatable, even to its Workspace Owner", () => {
    expect(
      canConfigureWorkspaceResource("workspace-owner", "sandbox", true),
    ).toBe(false);
  });

  it("Operator and Org Admin still configure a Sandbox", () => {
    expect(canConfigureWorkspaceResource("operator", "sandbox", false)).toBe(
      true,
    );
    expect(canConfigureWorkspaceResource("org-admin", "sandbox", false)).toBe(
      true,
    );
  });
});

describe.each([
  ["canManageOrgSharedResource", canManageOrgSharedResource],
  ["canConfigureSandbox", canConfigureSandbox],
  ["canListOrgMembers", canListOrgMembers],
  ["canCreateWorkspace", canCreateWorkspace],
  ["canManageWorkspaceDelegation", canManageWorkspaceDelegation],
] as const)("%s — Org-Admin-tier, no Workspace requirement", (_name, fn) => {
  it("the Operator is allowed", () => {
    expect(fn("operator")).toBe(true);
  });

  it("the Org Admin is allowed", () => {
    expect(fn("org-admin")).toBe(true);
  });

  it("the Workspace Owner is refused", () => {
    expect(fn("workspace-owner")).toBe(false);
  });

  it("a plain Org member is refused", () => {
    expect(fn("org-member")).toBe(false);
  });
});

describe("canSendChatMessages", () => {
  it("the literal Workspace owner is allowed", () => {
    expect(canSendChatMessages(true)).toBe(true);
  });

  it("a non-owner is refused, regardless of admin tier", () => {
    expect(canSendChatMessages(false)).toBe(false);
  });
});

describe("canAccessOrganization", () => {
  it("the Operator reaches an Organization with no membership at all", () => {
    expect(canAccessOrganization("operator", null)).toEqual({
      allowed: true,
    });
    expect(canAccessOrganization("operator", null, "admin")).toEqual({
      allowed: true,
    });
  });

  it("a non-member is refused", () => {
    expect(canAccessOrganization("org-admin", null)).toEqual({
      allowed: false,
      reason: "not-a-member",
    });
  });

  it("a member meets the default 'member' requirement", () => {
    expect(canAccessOrganization("org-member", "member")).toEqual({
      allowed: true,
    });
  });

  it("a member is refused an admin-only Organization surface", () => {
    expect(canAccessOrganization("org-member", "member", "admin")).toEqual({
      allowed: false,
      reason: "insufficient-role",
    });
  });

  it("an admin meets an admin-only requirement", () => {
    expect(canAccessOrganization("org-admin", "admin", "admin")).toEqual({
      allowed: true,
    });
  });
});

describe("canAccessWorkspace", () => {
  // The Workspace Owner case is their own Workspace; the caller resolves
  // ownership before it gets here.
  it.each([
    ["operator", true],
    ["org-admin", true],
    ["workspace-owner", true],
    ["org-member", false],
  ] as const)("%s: allowed=%s", (actor, allowed) => {
    expect(canAccessWorkspace(actor)).toBe(allowed);
  });
});

describe("isOperator", () => {
  it.each(ACTORS)("names the Operator case for %s", (actor) => {
    expect(isOperator(actor)).toBe(actor === "operator");
  });
});
