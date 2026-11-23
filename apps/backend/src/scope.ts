import type { auth } from "./auth.ts";

type SessionUser = typeof auth.$Infer.Session.user;

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

export const rootPrincipalOf = (
  p: Principal,
): Exclude<Principal, { kind: "subAgent" }> => {
  return p.kind === "subAgent" ? rootPrincipalOf(p.rootPrincipal) : p;
};

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

export type ScopeContext = {
  orgId: string;
  workspaceId: string;
};

export type WorkspaceScope = OrgScope &
  ScopeContext & {
    isWorkspaceOwner: boolean;
  };

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
