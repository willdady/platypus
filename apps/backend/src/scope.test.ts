import { describe, expect, it } from "vitest";
import {
  actorUserId,
  orgScope,
  rootPrincipalOf,
  userScope,
  workspaceScope,
  workspaceScopeForSubAgent,
  workspaceScopeForTrigger,
  type Principal,
} from "./scope.ts";

const fakeUser = { id: "user-1", name: "Alice" } as unknown as Parameters<
  typeof userScope
>[0];

describe("scope hierarchy", () => {
  it("builds nested scopes additively", () => {
    const u = userScope(fakeUser);
    const o = orgScope(u, "org-1");
    const w = workspaceScope(o, "ws-1", true);

    expect(w.principal).toEqual({
      kind: "user",
      userId: "user-1",
      name: "Alice",
    });
    expect(w.orgId).toBe("org-1");
    expect(w.workspaceId).toBe("ws-1");
    expect(w.isWorkspaceOwner).toBe(true);
  });

  it("does not mutate the parent when extending", () => {
    const u = userScope(fakeUser);
    const o = orgScope(u, "org-1");
    expect(u).not.toHaveProperty("orgId");
    expect(o).not.toHaveProperty("workspaceId");
  });
});

describe("workspaceScopeForTrigger", () => {
  it("constructs a trigger principal running as workspace owner", () => {
    const w = workspaceScopeForTrigger({
      triggerId: "trig-1",
      workspaceId: "ws-1",
      organizationId: "org-1",
      ownerUserId: "user-1",
      ownerName: "Alice",
    });

    expect(w.principal).toEqual({
      kind: "trigger",
      triggerId: "trig-1",
      onBehalfOfUserId: "user-1",
      name: "Alice",
    });
    expect(w.isWorkspaceOwner).toBe(true);
    expect(w.workspaceId).toBe("ws-1");
    expect(w.orgId).toBe("org-1");
  });
});

describe("workspaceScopeForSubAgent", () => {
  it("preserves org/workspace and chains the parent principal", () => {
    const parent = workspaceScope(
      orgScope(userScope(fakeUser), "org-1"),
      "ws-1",
      true,
    );
    const child = workspaceScopeForSubAgent(parent, "run-parent");

    expect(child.orgId).toBe("org-1");
    expect(child.workspaceId).toBe("ws-1");
    expect(child.principal.kind).toBe("subAgent");
    if (child.principal.kind === "subAgent") {
      expect(child.principal.parentRunId).toBe("run-parent");
      expect(child.principal.rootPrincipal).toEqual(parent.principal);
    }
  });
});

describe("rootPrincipalOf", () => {
  it("returns user principals unchanged", () => {
    const p: Principal = { kind: "user", userId: "u1", name: "Alice" };
    expect(rootPrincipalOf(p)).toBe(p);
  });

  it("returns trigger principals unchanged", () => {
    const p: Principal = {
      kind: "trigger",
      triggerId: "t1",
      onBehalfOfUserId: "u1",
      name: "Alice",
    };
    expect(rootPrincipalOf(p)).toBe(p);
  });

  it("walks through a single subAgent layer", () => {
    const root: Principal = { kind: "user", userId: "u1", name: "Alice" };
    const child: Principal = {
      kind: "subAgent",
      parentRunId: "r1",
      rootPrincipal: root,
    };
    expect(rootPrincipalOf(child)).toBe(root);
  });

  it("walks through deeply nested subAgent layers", () => {
    const root: Principal = {
      kind: "trigger",
      triggerId: "t1",
      onBehalfOfUserId: "u1",
      name: "Alice",
    };
    const l1: Principal = {
      kind: "subAgent",
      parentRunId: "r1",
      rootPrincipal: root,
    };
    const l2: Principal = {
      kind: "subAgent",
      parentRunId: "r2",
      rootPrincipal: l1,
    };
    const l3: Principal = {
      kind: "subAgent",
      parentRunId: "r3",
      rootPrincipal: l2,
    };
    expect(rootPrincipalOf(l3)).toBe(root);
  });
});

describe("actorUserId", () => {
  it("returns userId for user principals", () => {
    expect(actorUserId({ kind: "user", userId: "u1", name: "Alice" })).toBe(
      "u1",
    );
  });

  it("returns onBehalfOfUserId for trigger principals", () => {
    expect(
      actorUserId({
        kind: "trigger",
        triggerId: "t1",
        onBehalfOfUserId: "owner-1",
        name: "Alice",
      }),
    ).toBe("owner-1");
  });

  it("resolves through subAgent chains to the underlying user", () => {
    const root: Principal = { kind: "user", userId: "u1", name: "Alice" };
    const nested: Principal = {
      kind: "subAgent",
      parentRunId: "r1",
      rootPrincipal: {
        kind: "subAgent",
        parentRunId: "r0",
        rootPrincipal: root,
      },
    };
    expect(actorUserId(nested)).toBe("u1");
  });

  it("resolves through subAgent chains to a trigger's owner", () => {
    const root: Principal = {
      kind: "trigger",
      triggerId: "t1",
      onBehalfOfUserId: "owner-1",
      name: "Alice",
    };
    const nested: Principal = {
      kind: "subAgent",
      parentRunId: "r1",
      rootPrincipal: root,
    };
    expect(actorUserId(nested)).toBe("owner-1");
  });
});
