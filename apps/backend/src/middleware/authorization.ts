import { createMiddleware } from "hono/factory";
import { eq, and } from "drizzle-orm";
import { organizationMember, workspaceMember } from "../db/schema.ts";
import type {
  WorkspaceRole,
  SuperAdminOrgMembership,
  OrgRole,
} from "../server.ts";

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
const isSuperAdmin = (user: { role: string }): boolean => {
  return user.role === "admin";
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
  membership: any,
): membership is SuperAdminOrgMembership => {
  return membership?.isSuperAdmin === true;
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
  createMiddleware(async (c, next) => {
    const user = c.get("user");
    const db = c.get("db");

    // Super admins bypass all checks
    if (isSuperAdmin(user)) {
      const superAdminMembership: SuperAdminOrgMembership = {
        role: "admin",
        isSuperAdmin: true,
      };
      c.set("orgMembership", superAdminMembership);
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
    await next();
  });

/**
 * Middleware that validates user access to a workspace.
 *
 * **Prerequisites:**
 * - Must be used AFTER `requireOrgAccess` middleware (requires orgMembership in context)
 *
 * **Access Control:**
 * - Super admins bypass all checks and are granted admin access
 * - Org admins automatically get admin access to all workspaces in their organization
 * - Regular org members need explicit workspace membership
 * - Optional role restrictions can be enforced (e.g., admin/editor-only operations)
 *
 * **Behavior:**
 * - Extracts workspaceId using smart detection (URL params → query → body)
 * - Returns 400 if workspace ID not found in request
 * - Returns 403 if user doesn't have access to the workspace
 * - Returns 403 if user's role doesn't meet the required roles
 * - Sets `workspaceRole` and `workspaceMembership` in context
 *
 * @param requiredRoles - Optional array of roles required to access the resource.
 *                        If provided, user must have one of these roles.
 *                        Valid roles: "admin", "editor", "viewer"
 *                        Role hierarchy: admin > editor > viewer
 *
 * @example
 * ```typescript
 * // Allow any workspace member (viewer+)
 * app.get("/chats", requireAuth, requireOrgAccess(), requireWorkspaceAccess(), handler);
 *
 * // Require editor or admin
 * app.post("/agents", requireAuth, requireOrgAccess(),
 *   requireWorkspaceAccess(["admin", "editor"]), handler);
 *
 * // Require admin only
 * app.delete("/providers/:id", requireAuth, requireOrgAccess(),
 *   requireWorkspaceAccess(["admin"]), handler);
 * ```
 */
export const requireWorkspaceAccess = (requiredRoles?: WorkspaceRole[]) =>
  createMiddleware(async (c, next) => {
    const user = c.get("user");
    const db = c.get("db");
    const orgMembership = c.get("orgMembership");

    // Super admins bypass all checks
    if (isSuperAdmin(user)) {
      c.set("workspaceRole", "admin");
      c.set("workspaceMembership", null);
      await next();
      return;
    }

    // Get workspaceId from path parameters
    const workspaceId = c.req.param("workspaceId");

    if (!workspaceId) {
      return c.json({ error: "Workspace ID required" }, 400);
    }

    // Org admins have automatic admin access to all workspaces
    if (orgMembership.role === "admin") {
      c.set("workspaceRole", "admin");
      c.set("workspaceMembership", null); // No explicit membership needed
      await next();
      return;
    }

    // For regular members, check workspace-specific membership
    const [wsMembership] = await db
      .select()
      .from(workspaceMember)
      .where(
        and(
          eq(workspaceMember.userId, user.id),
          eq(workspaceMember.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!wsMembership) {
      return c.json({ error: "No access to this workspace" }, 403);
    }

    if (
      requiredRoles &&
      !requiredRoles.includes(wsMembership.role as WorkspaceRole)
    ) {
      return c.json({ error: "Insufficient workspace permissions" }, 403);
    }

    c.set("workspaceRole", wsMembership.role);
    c.set("workspaceMembership", wsMembership);
    await next();
  });

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
export const requireSuperAdmin = createMiddleware(async (c, next) => {
  const user = c.get("user");

  if (!isSuperAdmin(user)) {
    return c.json({ error: "Super admin access required" }, 403);
  }

  await next();
});

export { isSuperAdmin, isSuperAdminMembership };
