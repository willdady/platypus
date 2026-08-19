/**
 * Frontend counterpart to the backend's authorization module
 * (`apps/backend/src/middleware/authorization.ts`): the actor is a named
 * value — never a role boolean a caller reconstructs into policy — and each
 * function answers whether that actor may perform one action, returning a
 * typed denial reason rather than throwing (ADR-0010).
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
  isWorkspaceOwner: boolean;
}

export function resolveActor(context: ActorContext): Actor {
  if (context.isOperator) return "operator";
  if (context.orgRole === "admin") return "org-admin";
  if (context.isWorkspaceOwner) return "workspace-owner";
  return "org-member";
}

const isOrgAdminOrAbove = (actor: Actor): boolean =>
  actor === "operator" || actor === "org-admin";

// ---- Shared resources: attach / detach / Promote (ADR-0007) ----

export type SharedResourceDenial = "no-workspace-context" | "not-org-admin";

export type SharedResourceAccess = Access<SharedResourceDenial>;

/**
 * Attach, detach, and Promote a Shared resource are the same rule (ADR-0007)
 * — an Org Admin action, available only inside a Workspace — collapsed to
 * one decision instead of five independent spellings.
 */
export function canManageSharedResource(
  actor: Actor,
  workspaceId: string | undefined,
): SharedResourceAccess {
  if (!workspaceId) return { allowed: false, reason: "no-workspace-context" };
  if (!isOrgAdminOrAbove(actor)) {
    return { allowed: false, reason: "not-org-admin" };
  }
  return { allowed: true };
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

export type ConfigAccessDenial =
  "not-owner" | "not-delegatable" | "not-delegated";

export type Access<Reason> =
  { allowed: true } | { allowed: false; reason: Reason };

export type WorkspaceConfigAccess = Access<ConfigAccessDenial>;

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
): WorkspaceConfigAccess {
  if (isOrgAdminOrAbove(actor)) return { allowed: true };
  if (actor !== "workspace-owner") {
    return { allowed: false, reason: "not-owner" };
  }
  if (type === "sandbox") return { allowed: false, reason: "not-delegatable" };
  if (!delegated) return { allowed: false, reason: "not-delegated" };
  return { allowed: true };
}

// ---- Route-level access ----

export type OrgAccessDenial = "not-a-member" | "insufficient-role";

export type OrgAccess = Access<OrgAccessDenial>;

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
