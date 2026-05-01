import type { auth } from "./auth.ts";

type SessionUser = typeof auth.$Infer.Session.user;

/**
 * Identifies the actor responsible for a unit of work.
 *
 * - `user`: an interactive user from an HTTP session.
 * - `trigger`: a scheduled or event-driven trigger run, executing on behalf
 *   of the workspace owner.
 * - `subAgent`: a nested run spawned from a parent run; chases up
 *   `rootPrincipal` to find the real actor.
 */
export type Principal =
  | { kind: "user"; userId: string; name: string }
  | {
      kind: "trigger";
      triggerId: string;
      onBehalfOfUserId: string;
      name: string;
    }
  | { kind: "subAgent"; parentRunId: string; rootPrincipal: Principal };

/** Walks the principal chain to find the non-subAgent actor at the root. */
export const rootPrincipalOf = (
  p: Principal,
): Exclude<Principal, { kind: "subAgent" }> => {
  return p.kind === "subAgent" ? rootPrincipalOf(p.rootPrincipal) : p;
};

/** The user ID on whose behalf this principal is running. */
export const actorUserId = (p: Principal): string => {
  const root = rootPrincipalOf(p);
  return root.kind === "user" ? root.userId : root.onBehalfOfUserId;
};

export type UserScope = {
  principal: Principal;
};

export type OrgScope = UserScope & {
  orgId: string;
};

export type WorkspaceScope = OrgScope & {
  workspaceId: string;
  isWorkspaceOwner: boolean;
};

// === Factories ===

export const userScope = (user: SessionUser): UserScope => ({
  principal: { kind: "user", userId: user.id, name: user.name },
});

export const orgScope = (parent: UserScope, orgId: string): OrgScope => ({
  ...parent,
  orgId,
});

export const workspaceScope = (
  parent: OrgScope,
  workspaceId: string,
  isWorkspaceOwner: boolean,
): WorkspaceScope => ({
  ...parent,
  workspaceId,
  isWorkspaceOwner,
});

/**
 * Builds a scope for a trigger run. Triggers execute on behalf of the
 * workspace owner with full owner privileges.
 */
export const workspaceScopeForTrigger = (params: {
  triggerId: string;
  workspaceId: string;
  organizationId: string;
  ownerUserId: string;
  ownerName: string;
}): WorkspaceScope => ({
  principal: {
    kind: "trigger",
    triggerId: params.triggerId,
    onBehalfOfUserId: params.ownerUserId,
    name: params.ownerName,
  },
  orgId: params.organizationId,
  workspaceId: params.workspaceId,
  isWorkspaceOwner: true,
});

/**
 * Derives a child scope for a sub-agent invocation, preserving the parent's
 * org/workspace and chaining the parent's principal so the root actor
 * remains recoverable.
 */
export const workspaceScopeForSubAgent = (
  parent: WorkspaceScope,
  parentRunId: string,
): WorkspaceScope => ({
  ...parent,
  principal: {
    kind: "subAgent",
    parentRunId,
    rootPrincipal: parent.principal,
  },
});
