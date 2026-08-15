import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { eq, and } from "drizzle-orm";
import {
  organizationMember,
  workspace as workspaceTable,
} from "../db/schema.ts";
import type {
  SuperAdminOrgMembership,
  OrgRole,
  OrganizationMembership,
  Variables,
} from "../server.ts";
import {
  orgScope,
  userScope,
  workspaceScope,
  type OrgScope,
  type WorkspaceScope,
} from "../scope.ts";

/** Hono environment for these middleware: carries the request-scoped Variables. */
type Env = { Variables: Variables };

/**
 * The Organization scope {@link requireOrgAccess} resolved for this request —
 * who is asking, and which Organization they were cleared for.
 *
 * Throws when that middleware did not run, which is a wiring mistake in the
 * route table rather than anything the caller did: the alternative is every
 * handler re-reading `c.req.param("orgId")!`, asserting an invariant it cannot
 * see. `app.onError` maps the throw to a 500 (ADR-0010), which is the honest
 * answer — the route is misconfigured.
 */
export const orgScopeOf = (c: Context<Env>): OrgScope => {
  const scope = c.get("orgScope");
  if (!scope) {
    throw new Error(
      "No organization scope on this request: requireOrgAccess must run before the handler",
    );
  }
  return scope;
};

/**
 * The Workspace scope {@link requireWorkspaceAccess} resolved for this request:
 * the Organization scope plus the Workspace and whether the caller owns it.
 *
 * This is the currency handlers pass down — `listScoped(db, "agent", scope)`,
 * `requireBoard(db, scope, id)` — so route bodies never parse the URL. Throws
 * on the same wiring mistake {@link orgScopeOf} does.
 */
export const workspaceScopeOf = (c: Context<Env>): WorkspaceScope => {
  const scope = c.get("workspaceScope");
  if (!scope) {
    throw new Error(
      "No workspace scope on this request: requireWorkspaceAccess must run before the handler",
    );
  }
  return scope;
};

/**
 * Checks if a user is a super admin based on their role field.
 * Super admins have full platform-level access.
 *
 * @param user - The user object with role field
 * @returns True if the user is a super admin, false otherwise
 *
 * @example
 * ```typescript
 * if (isSuperAdmin(user)) {
 *   // Grant full platform access
 * }
 * ```
 */
const isSuperAdmin = (user: { role?: string | null } | undefined): boolean => {
  return user?.role === "admin";
};

/**
 * Type guard to check if an organization membership is from a super admin.
 * Useful for discriminating between regular and super admin memberships in route handlers.
 *
 * @param membership - The organization membership to check
 * @returns True if the membership is a super admin membership
 *
 * @example
 * ```typescript
 * const orgMembership = c.get("orgMembership");
 * if (isSuperAdminMembership(orgMembership)) {
 *   // TypeScript knows orgMembership.isSuperAdmin is true
 *   console.log("Super admin access");
 * } else {
 *   // TypeScript knows this is a regular OrganizationMembership
 *   console.log("Regular member:", orgMembership.userId);
 * }
 * ```
 */
const isSuperAdminMembership = (
  membership: OrganizationMembership | SuperAdminOrgMembership | undefined,
): membership is SuperAdminOrgMembership => {
  return (
    membership != null &&
    "isSuperAdmin" in membership &&
    membership.isSuperAdmin === true
  );
};

/**
 * Middleware that validates user access to an organization.
 *
 * **Access Control:**
 * - Super admins bypass all checks and are granted admin access
 * - Regular users must be members of the organization
 * - Optional role restrictions can be enforced (e.g., admin-only operations)
 *
 * **Behavior:**
 * - Extracts orgId using smart detection (URL params → query → body)
 * - Returns 400 if organization ID not found in request
 * - Returns 403 if user is not a member of the organization
 * - Returns 403 if user's role doesn't meet the required roles
 * - Sets `orgMembership` in context with user's membership details
 *
 * @param requiredRoles - Optional array of roles required to access the resource.
 *                        If provided, user must have one of these roles.
 *                        Valid roles: "admin", "member"
 *
 * @example
 * ```typescript
 * // Allow any org member
 * app.get("/organizations/:id", requireAuth, requireOrgAccess(), handler);
 *
 * // Require admin role
 * app.delete("/organizations/:id", requireAuth, requireOrgAccess(["admin"]), handler);
 * ```
 */
export const requireOrgAccess = (requiredRoles?: OrgRole[]) =>
  createMiddleware<Env>(async (c, next) => {
    // requireAuth runs first, so user is always set here.
    const user = c.get("user")!;
    const db = c.get("db");

    const parentScope = c.get("userScope") ?? userScope(user);

    // Super admins bypass all checks
    if (isSuperAdmin(user)) {
      const superAdminMembership: SuperAdminOrgMembership = {
        role: "admin",
        isSuperAdmin: true,
      };
      c.set("orgMembership", superAdminMembership);
      const orgIdParam = c.req.param("orgId");
      if (orgIdParam) {
        c.set("orgScope", orgScope(parentScope, orgIdParam));
      }
      await next();
      return;
    }

    // Get orgId from path parameters
    const orgId = c.req.param("orgId");

    if (!orgId) {
      return c.json({ error: "Organization ID required" }, 400);
    }

    const [membership] = await db
      .select()
      .from(organizationMember)
      .where(
        and(
          eq(organizationMember.userId, user.id),
          eq(organizationMember.organizationId, orgId),
        ),
      )
      .limit(1);

    if (!membership) {
      return c.json({ error: "Not a member of this organization" }, 403);
    }

    if (requiredRoles && !requiredRoles.includes(membership.role as OrgRole)) {
      return c.json({ error: "Insufficient organization permissions" }, 403);
    }

    c.set("orgMembership", membership);
    c.set("orgScope", orgScope(parentScope, orgId));
    await next();
  });

/**
 * Middleware that validates user access to a workspace.
 *
 * **Prerequisites:**
 * - Must be used AFTER `requireOrgAccess` middleware (requires orgMembership in context)
 *
 * **Access Control:**
 * - Super admins bypass all checks
 * - Org admins have access to all workspaces in their organization
 * - Regular org members can only access workspaces they own
 *
 * **Behavior:**
 * - Extracts workspaceId from URL params
 * - Returns 400 if workspace ID not found in request
 * - Returns 404 if workspace not found
 * - Returns 403 if user doesn't have access
 * - Sets `isWorkspaceOwner` in context
 *
 * @example
 * ```typescript
 * app.get("/chats", requireAuth, requireOrgAccess(), requireWorkspaceAccess, handler);
 * ```
 */
export const requireWorkspaceAccess = createMiddleware<Env>(async (c, next) => {
  // requireAuth and requireOrgAccess run first, so user and orgMembership are set.
  const user = c.get("user")!;
  const db = c.get("db");
  const orgMembership = c.get("orgMembership")!;

  // The Organization half is already resolved and proved; only the Workspace id
  // is still unread, and this middleware is the one place that reads it.
  const parent = orgScopeOf(c);
  const workspaceId = c.req.param("workspaceId");

  if (!workspaceId) {
    return c.json({ error: "Workspace ID required" }, 400);
  }

  // Fetch the workspace once for every role branch below.
  const [ws] = await db
    .select()
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);

  if (!ws) {
    return c.json({ error: "Workspace not found" }, 404);
  }

  // Cross-org guard: the workspace must belong to the organization the caller
  // was cleared for. Without this, an admin (or super admin) of org A who knows
  // a workspace id in org B could operate on it via
  // /organizations/A/workspaces/B. Reply 404 (not 403) so we don't leak the
  // existence of other orgs' workspaces. Applies uniformly to the member,
  // org-admin, and super-admin cases below.
  if (ws.organizationId !== parent.orgId) {
    return c.json({ error: "Workspace not found" }, 404);
  }

  const isOwner = ws.ownerId === user.id;

  // Super admins and org admins reach any workspace in the organization; a
  // regular member reaches only their own. Ownership is recorded either way —
  // an admin operating on someone else's workspace is not its owner, and the
  // routes that gate on ownership (ADR-0006) need to know.
  const mayAccess =
    isSuperAdmin(user) || orgMembership.role === "admin" || isOwner;
  if (!mayAccess) {
    return c.json({ error: "No access to this workspace" }, 403);
  }

  c.set("isWorkspaceOwner", isOwner);
  c.set("workspaceScope", workspaceScope(parent, workspaceId, isOwner));
  await next();
});

/**
 * Middleware that gates configuration of credential- and reach-bearing
 * resources (Providers, Sandboxes, MCPs) per ADR-0006.
 *
 * **Prerequisites:**
 * - Must run AFTER `requireOrgAccess` and `requireWorkspaceAccess` (relies on
 *   `orgMembership` and `isWorkspaceOwner` in context).
 *
 * **Access Control:**
 * - Super admins and org admins always pass.
 * - A non-admin Workspace Owner passes only when a `delegationFlag` is supplied
 *   AND that boolean column is `true` on the workspace row. Without a flag, the
 *   resource is admin-only and never delegatable (e.g. Sandboxes).
 *
 * @param delegationFlag - Optional workspace column that, when true, lets the
 *                         owner self-manage this resource. Omit for admin-only.
 *
 * @example
 * ```typescript
 * // Sandbox: admin-only, never delegatable
 * sandbox.post("/", requireAuth, requireOrgAccess(), requireWorkspaceAccess, requireWorkspaceConfigAccess(), handler);
 *
 * // MCP: admin by default, owner if the workspace flag is set
 * mcp.post("/", requireAuth, requireOrgAccess(), requireWorkspaceAccess, requireWorkspaceConfigAccess("mcpSelfManagement"), handler);
 * ```
 */
export const requireWorkspaceConfigAccess = (delegationFlag?: DelegationFlag) =>
  createMiddleware<Env>(async (c, next) => {
    const access = await workspaceConfigAccess(c, delegationFlag);

    if (!access.allowed) {
      return c.json({ error: CONFIG_ACCESS_DENIED[access.reason] }, 403);
    }

    await next();
  });

/** The workspace columns that let an Org Admin delegate a resource to its Owner. */
export type DelegationFlag = "providerSelfManagement" | "mcpSelfManagement";

/**
 * Why a caller may not configure a credential- and reach-bearing resource.
 * Carried rather than thrown so read paths can redact on the same rule the
 * write paths reject on.
 */
export type ConfigAccessDenial =
  /** Not an admin, and not even the Workspace Owner. */
  | "not-owner"
  /** Owner, but the resource is admin-only and never delegatable. */
  | "not-delegatable"
  /** Owner of a workspace where this resource's delegation flag is off. */
  | "not-delegated";

export type WorkspaceConfigAccess =
  { allowed: true } | { allowed: false; reason: ConfigAccessDenial };

const CONFIG_ACCESS_DENIED: Record<ConfigAccessDenial, string> = {
  "not-owner": "Admin access required",
  "not-delegatable": "Only an organization admin can configure this resource",
  "not-delegated":
    "Self-management of this resource is not enabled for this workspace",
};

/**
 * The single authority on ADR-0006's question: may this caller configure a
 * credential- and reach-bearing resource in this Workspace?
 *
 * Two callers, two shapes of the same rule — which is why the decision is
 * returned rather than enforced here:
 * - {@link requireWorkspaceConfigAccess} maps a denial to a 403 on write routes.
 * - the Provider and MCP read routes map it to *redaction*, revealing stored
 *   credentials only to a caller who is allowed to manage them. Gating the reads
 *   outright is not an option: a Workspace Owner has to see which Providers and
 *   MCPs exist in order to select one on an Agent or Chat, delegated or not.
 *
 * **Prerequisites:** must run after `requireOrgAccess` and
 * `requireWorkspaceAccess` (reads `orgMembership` and `isWorkspaceOwner`).
 *
 * @param delegationFlag - Omit for admin-only resources that are never delegatable.
 */
export const workspaceConfigAccess = async (
  c: Context<Env>,
  delegationFlag?: DelegationFlag,
): Promise<WorkspaceConfigAccess> => {
  const user = c.get("user");
  const orgMembership = c.get("orgMembership");

  // Super admins and org admins always manage credential-bearing config.
  if (isSuperAdmin(user) || orgMembership?.role === "admin") {
    return { allowed: true };
  }

  // Past requireWorkspaceAccess, a non-admin can only be the workspace owner.
  if (!c.get("isWorkspaceOwner")) {
    return { allowed: false, reason: "not-owner" };
  }

  if (!delegationFlag) {
    return { allowed: false, reason: "not-delegatable" };
  }

  const db = c.get("db");
  const { workspaceId } = workspaceScopeOf(c);
  const [ws] = await db
    .select({ flag: workspaceTable[delegationFlag] })
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);

  if (!ws?.flag) {
    return { allowed: false, reason: "not-delegated" };
  }

  return { allowed: true };
};

/** The Scoped resource types that store Operator-entered credentials. */
export type CredentialResourceType = "mcp" | "provider";

/**
 * ADR-0006's delegation flag for each credential-bearing Scoped resource —
 * written down once, so a read path cannot redact on one rule while its write
 * path rejects on another.
 */
const CREDENTIAL_DELEGATION_FLAG: Record<
  CredentialResourceType,
  DelegationFlag
> = {
  mcp: "mcpSelfManagement",
  provider: "providerSelfManagement",
};

/**
 * The Workspace surface's answer to "may this caller see this resource's stored
 * credentials?" — {@link workspaceConfigAccess} read as a yes/no, since a read
 * path redacts rather than reporting *why* it refused.
 */
export const workspaceCredentialsVisible = async (
  c: Context<Env>,
  type: CredentialResourceType,
): Promise<boolean> =>
  (await workspaceConfigAccess(c, CREDENTIAL_DELEGATION_FLAG[type])).allowed;

/**
 * The Organization surface's twin. A Shared resource is configured only by an
 * Org Admin (ADR-0006, ADR-0007) — there is no per-workspace delegation at org
 * scope — so admin *is* the whole rule. Super admins arrive here as admins,
 * because `requireOrgAccess` grants them an admin membership.
 */
export const orgCredentialsVisible = (c: Context<Env>): boolean =>
  c.get("orgMembership")?.role === "admin";

/**
 * Middleware that restricts access to super admins only.
 *
 * **Purpose:**
 * Used for platform-level administrative operations that should only be
 * accessible to users with role="admin".
 *
 * **Behavior:**
 * - Checks if authenticated user's role is "admin"
 * - Returns 403 if user is not a super admin
 * - Allows request to proceed if user is a super admin
 *
 * **Use Cases:**
 * - Creating new organizations
 * - Platform-wide configuration changes
 * - System administration tasks
 *
 * @example
 * ```typescript
 * // Restrict organization creation to super admins only
 * app.post("/organizations", requireAuth, requireSuperAdmin, handler);
 *
 * // Platform settings (super admin only)
 * app.put("/system/settings", requireAuth, requireSuperAdmin, handler);
 * ```
 */
export const requireSuperAdmin = createMiddleware<Env>(async (c, next) => {
  const user = c.get("user");

  if (!isSuperAdmin(user)) {
    return c.json({ error: "Super admin access required" }, 403);
  }

  await next();
});

/**
 * Middleware that validates the user is the workspace owner.
 *
 * **Prerequisites:**
 * - Must be used AFTER `requireOrgAccess` and `requireWorkspaceAccess` middleware
 *
 * **Access Control:**
 * - Only the workspace owner can access the resource
 * - Super admins and org admins are NOT allowed (they only have read access)
 *
 * **Behavior:**
 * - Checks if authenticated user is the workspace owner
 * - Returns 403 if user is not the owner
 * - Allows request to proceed if user is the owner
 *
 * **Use Cases:**
 * - Creating new chats
 * - Submitting chat messages
 * - Updating or deleting chats
 *
 * @example
 * ```typescript
 * // Only workspace owner can create chats
 * app.post("/chats", requireAuth, requireOrgAccess(), requireWorkspaceAccess, requireWorkspaceOwner, handler);
 *
 * // Only workspace owner can submit messages
 * app.post("/chats/:id/messages", requireAuth, requireOrgAccess(), requireWorkspaceAccess, requireWorkspaceOwner, handler);
 * ```
 */
export const requireWorkspaceOwner = createMiddleware<Env>(async (c, next) => {
  const isWorkspaceOwner = c.get("isWorkspaceOwner");

  if (!isWorkspaceOwner) {
    return c.json(
      { error: "Only the workspace owner can perform this action" },
      403,
    );
  }

  await next();
});

export { isSuperAdmin, isSuperAdminMembership };
