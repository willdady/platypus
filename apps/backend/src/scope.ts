import type { auth } from "./auth.ts";

type SessionUser = typeof auth.$Infer.Session.user;

/**
 * Identifies the actor responsible for a unit of work.
 *
 * - `user`: an interactive user from an HTTP session.
 * - `trigger`: a scheduled or event-driven trigger run, executing on behalf
 *   of the workspace owner.
 * - `a2a`: a turn an A2A client started through an A2A endpoint (ADR-0032),
 *   on behalf of the workspace owner. `name` is the token's name.
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
  | {
      kind: "a2a";
      endpointId: string;
      tokenId: string;
      name: string;
      onBehalfOfUserId: string;
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

/**
 * Which Workspace a lookup is placed in, with no actor attached — the half of a
 * {@link WorkspaceScope} that a data-access module actually reads.
 *
 * Kept separate from `WorkspaceScope` because not every caller has a
 * `Principal` to offer: the Agent-facing Tools are built from the SDK's
 * `ToolSetContext`, which carries ids across the plugin boundary and cannot
 * name a backend-internal principal type. A `WorkspaceScope` satisfies this
 * structurally, so a handler passes the middleware's value straight through.
 */
export type ScopeContext = {
  orgId: string;
  workspaceId: string;
};

export type WorkspaceScope = OrgScope &
  ScopeContext & {
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
 * Builds a scope for an A2A turn. Like a trigger run, it acts as the
 * workspace owner, who issued the token.
 */
export const workspaceScopeForA2a = (params: {
  endpointId: string;
  tokenId: string;
  tokenName: string;
  workspaceId: string;
  organizationId: string;
  ownerUserId: string;
}): WorkspaceScope => ({
  principal: {
    kind: "a2a",
    endpointId: params.endpointId,
    tokenId: params.tokenId,
    name: params.tokenName,
    onBehalfOfUserId: params.ownerUserId,
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
