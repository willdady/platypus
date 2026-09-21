/**
 * Frontend counterpart to the backend's authorization module
 * (`apps/backend/src/middleware/authorization.ts`): the actor is a named
 * value — never a role boolean a caller reconstructs into policy — and each
 * function answers whether that actor may perform one action. Checks return a
 * plain boolean; only `canAccessOrganization` returns a typed denial reason,
 * because the UI renders which refusal it was (ADR-0010).
 */

export type OrgRole = "admin" | "member";

/**
 * The three actors named in CONTEXT.md, ranked by the authority tier they
 * hold: Operator > Org Admin > Workspace Owner > plain Org member. A caller
 * cleared for a higher tier is always cleared for what a lower tier can do.
 */
export type Actor = "operator" | "org-admin" | "workspace-owner" | "org-member";

export interface ActorContext {
  /** The platform super-admin, i.e. `user.role === "admin"`. */
  isOperator: boolean;
  /** The caller's role in the Organization in scope, or null outside one. */
  orgRole: OrgRole | null;
  /** Whether the caller owns the Workspace in scope. */
  ownsWorkspace: boolean;
}

export function resolveActor(context: ActorContext): Actor {
  if (context.isOperator) return "operator";
  if (context.orgRole === "admin") return "org-admin";
  if (context.ownsWorkspace) return "workspace-owner";
  return "org-member";
}

const isOrgAdminOrAbove = (actor: Actor): boolean =>
  actor === "operator" || actor === "org-admin";

// ---- Shared resources: attach / detach / Promote (ADR-0007) ----

/**
 * Attach, detach, and Promote a Shared resource are the same rule (ADR-0007)
 * — an Org Admin action, available only inside a Workspace — collapsed to
 * one decision instead of five independent spellings.
 */
export function canManageSharedResource(
  actor: Actor,
  workspaceId: string | undefined,
): boolean {
  if (!workspaceId) return false;
  return isOrgAdminOrAbove(actor);
}

// ---- Credential/reach-bearing config delegation (ADR-0006) ----

/** Scoped resources ADR-0006 allows an Org Admin to delegate to the Owner. */
export type DelegatableResourceType = "provider" | "mcp";
export type CredentialResourceType = DelegatableResourceType | "sandbox";

/** A Workspace's own ADR-0006 delegation flags, as stored on its row. */
export interface WorkspaceDelegationFlags {
  providerSelfManagement: boolean;
  mcpSelfManagement: boolean;
}

/**
 * ADR-0006: may this actor configure a credential- and reach-bearing
 * Workspace resource? Sandboxes are never delegatable; Providers and MCPs
 * delegate to the Workspace Owner only when the workspace's own delegation
 * flag is set. Resolved once here so a read path (credential redaction) and
 * a write path can't drift onto two different rules.
 */
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

// ---- Route-level access ----

export type OrgAccessDenial = "not-a-member" | "insufficient-role";

export type OrgAccess =
  { allowed: true } | { allowed: false; reason: OrgAccessDenial };

/** Authority tiers, ordered so a higher role satisfies a lower requirement. */
const ORG_ROLE_RANK: Record<OrgRole, number> = { member: 1, admin: 2 };

/**
 * May this actor reach an Organization, optionally requiring at least
 * `requiredRole`? The Operator bypasses membership entirely, mirroring the
 * backend's `requireOrgAccess`.
 */
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

/**
 * May this actor reach a Workspace at all? Operator and Org Admin reach
 * every Workspace in the Organization; a Workspace Owner reaches their own
 * (the only one `resolveActor` would have classified them as owning); a
 * plain Org member reaches none.
 */
export function canAccessWorkspace(actor: Actor): boolean {
  return actor !== "org-member";
}

/** May this actor reach a platform-level, Operator-only surface? */
export function isOperator(actor: Actor): boolean {
  return actor === "operator";
}

// ---- Org-Admin-tier actions with no Workspace requirement ----

/** Shared body for every Org-Admin-tier, no-Workspace-requirement capability below. */
const orgAdminOnly = (actor: Actor): boolean => isOrgAdminOrAbove(actor);

/**
 * May this actor manage a Shared resource on the Organization settings
 * surface — editing, deleting, or changing its Workspace attachments,
 * outside any Workspace (ADR-0007)? The sibling of
 * {@link canManageSharedResource} for that surface: same Org Admin rule,
 * without the Workspace requirement that governs attach/detach/Promote from
 * inside a Workspace.
 */
export const canManageOrgSharedResource = orgAdminOnly;

/**
 * ADR-0006: may this actor configure the Workspace's Sandbox? Unlike
 * Providers and MCPs, a Sandbox is never delegatable to the Workspace
 * Owner, so this is a plain Org Admin gate rather than
 * {@link canConfigureWorkspaceResource}'s delegation check.
 */
export const canConfigureSandbox = orgAdminOnly;

/** May this actor list the Organization's members? The backend endpoint is admin-only. */
export const canListOrgMembers = orgAdminOnly;

/** ADR-0008: may this actor create a Workspace in this Organization? */
export const canCreateWorkspace = orgAdminOnly;

/**
 * ADR-0006: may this actor toggle a Workspace's delegation flags
 * (`providerSelfManagement`, `mcpSelfManagement`)? Always an Org Admin
 * decision — the flags are what let a Workspace Owner self-manage a
 * Provider or MCP in the first place, so the Owner can't grant themself
 * that.
 */
export const canManageWorkspaceDelegation = orgAdminOnly;

// ---- Chat: literal Workspace ownership (not the `Actor` tier) ----

/**
 * May this caller send chat messages in this Workspace? Mirrors the
 * backend's `requireWorkspaceOwner`: literal ownership only — an Org Admin
 * or the Operator viewing someone else's Workspace gets read-only, same as
 * any other non-owner. Takes ownership directly rather than `Actor`, whose
 * tier ranking would otherwise fold an Org-Admin-who-owns-it into
 * `"org-admin"` and hide the case this asks about.
 */
export function canSendChatMessages(ownsWorkspace: boolean): boolean {
  return ownsWorkspace;
}
