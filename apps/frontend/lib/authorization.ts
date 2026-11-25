export type OrgRole = "admin" | "member";

export type Actor = "operator" | "org-admin" | "workspace-owner" | "org-member";

export type ActorContext = {
  isOperator: boolean;
  orgRole: OrgRole | null;
  ownsWorkspace: boolean;
};

export function resolveActor(context: ActorContext): Actor {
  if (context.isOperator) return "operator";
  if (context.orgRole === "admin") return "org-admin";
  if (context.ownsWorkspace) return "workspace-owner";
  return "org-member";
}

function isOrgAdminOrAbove(actor: Actor): boolean {
  return actor === "operator" || actor === "org-admin";
}

export function canManageSharedResource(
  actor: Actor,
  workspaceId: string | undefined,
): boolean {
  if (!workspaceId) return false;
  return isOrgAdminOrAbove(actor);
}

export type DelegatableResourceType = "provider" | "mcp";
export type CredentialResourceType = DelegatableResourceType | "sandbox";

export type WorkspaceDelegationFlags = {
  providerSelfManagement: boolean;
  mcpSelfManagement: boolean;
};

export function canConfigureWorkspaceResource(
  actor: Actor,
  type: CredentialResourceType,
  delegated: boolean,
): boolean {
  if (isOrgAdminOrAbove(actor)) return true;
  if (actor !== "workspace-owner") return false;
  if (type === "sandbox") return false;
  return delegated;
}

export type OrgAccessDenial = "not-a-member" | "insufficient-role";

export type OrgAccess =
  { allowed: true } | { allowed: false; reason: OrgAccessDenial };

const ORG_ROLE_RANK: Record<OrgRole, number> = { member: 1, admin: 2 };

export function canAccessOrganization(
  actor: Actor,
  orgRole: OrgRole | null,
  requiredRole: OrgRole = "member",
): OrgAccess {
  if (actor === "operator") return { allowed: true };
  if (!orgRole) return { allowed: false, reason: "not-a-member" };
  if (ORG_ROLE_RANK[orgRole] < ORG_ROLE_RANK[requiredRole]) {
    return { allowed: false, reason: "insufficient-role" };
  }
  return { allowed: true };
}

export function canAccessWorkspace(actor: Actor): boolean {
  return actor !== "org-member";
}

export function isOperator(actor: Actor): boolean {
  return actor === "operator";
}

function orgAdminOnly(actor: Actor): boolean {
  return isOrgAdminOrAbove(actor);
}

export const canManageOrgSharedResource = orgAdminOnly;

export const canConfigureSandbox = orgAdminOnly;

export const canCreateWorkspace = orgAdminOnly;

export const canOpenOrgSettings = orgAdminOnly;

export const canManageWorkspaceDelegation = orgAdminOnly;

export const canTransferWorkspace = orgAdminOnly;

// why: literal ownership, not Actor — an owning Org Admin still cannot send
export function canSendChatMessages(ownsWorkspace: boolean): boolean {
  return ownsWorkspace;
}

export function canChangeChat(ownsWorkspace: boolean): boolean {
  return ownsWorkspace;
}

export function canPinAgent(ownsWorkspace: boolean): boolean {
  return ownsWorkspace;
}

export function canCreateAgent(ownsWorkspace: boolean): boolean {
  return ownsWorkspace;
}
