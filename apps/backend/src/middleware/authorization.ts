import { createMiddleware } from "hono/factory";
import { eq, and } from "drizzle-orm";
import { organisationMember, workspaceMember } from "../db/schema.ts";
import type { Context } from "hono";
import type {
  WorkspaceRole,
  SuperAdminOrgMembership,
  OrgRole,
} from "../server.ts";

/**
 * Checks if a user is a super admin based on email address.
 * Super admins are defined in the SUPER_ADMIN_EMAILS environment variable
 * as a comma-separated list of email addresses.
 *
 * @param userEmail - The email address to check
 * @returns True if the user is a super admin, false otherwise
 *
 * @example
 * ```typescript
 * if (isSuperAdmin("admin@example.com")) {
 *   // Grant full platform access
 * }
 * ```
 */
const isSuperAdmin = (userEmail: string): boolean => {
  const superAdminEmails =
    process.env.SUPER_ADMIN_EMAILS?.split(",").map((e) => e.trim()) || [];
  return superAdminEmails.includes(userEmail);
};

/**
 * Type guard to check if an organisation membership is from a super admin.
 * Useful for discriminating between regular and super admin memberships in route handlers.
 *
 * @param membership - The organisation membership to check
 * @returns True if the membership is a super admin membership
 *
 * @example
 * ```typescript
 * const orgMembership = c.get("orgMembership");
 * if (isSuperAdminMembership(orgMembership)) {
 *   // TypeScript knows orgMembership.isSuperAdmin is true
 *   console.log("Super admin access");
 * } else {
 *   // TypeScript knows this is a regular OrganisationMembership
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
 * Middleware that validates user access to an organisation.
 *
 * **Access Control:**
 * - Super admins bypass all checks and are granted admin access
 * - Regular users must be members of the organisation
 * - Optional role restrictions can be enforced (e.g., admin-only operations)
 *
 * **Behavior:**
 * - Extracts orgId using smart detection (URL params → query → body)
 * - Returns 400 if organisation ID not found in request
 * - Returns 403 if user is not a member of the organisation
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
 * app.get("/organisations/:id", requireAuth, requireOrgAccess(), handler);
 *
 * // Require admin role
 * app.delete("/organisations/:id", requireAuth, requireOrgAccess(["admin"]), handler);
 * ```
 */
export const requireOrgAccess = (requiredRoles?: OrgRole[]) =>
  createMiddleware(async (c, next) => {
    const user = c.get("user");
    const db = c.get("db");

    // Super admins bypass all checks
    if (isSuperAdmin(user.email)) {
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
      return c.json({ error: "Organisation ID required" }, 400);
    }

    const [membership] = await db
      .select()
      .from(organisationMember)
      .where(
        and(
          eq(organisationMember.userId, user.id),
          eq(organisationMember.organisationId, orgId),
        ),
      )
      .limit(1);

    if (!membership) {
      return c.json({ error: "Not a member of this organisation" }, 403);
    }

    if (requiredRoles && !requiredRoles.includes(membership.role as OrgRole)) {
      return c.json({ error: "Insufficient organisation permissions" }, 403);
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
 * - Org admins automatically get admin access to all workspaces in their organisation
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
    if (isSuperAdmin(user.email)) {
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
 * accessible to super admins defined in the SUPER_ADMIN_EMAILS environment variable.
 *
 * **Behavior:**
 * - Checks if authenticated user's email is in the super admin list
 * - Returns 403 if user is not a super admin
 * - Allows request to proceed if user is a super admin
 *
 * **Use Cases:**
 * - Creating new organisations
 * - Platform-wide configuration changes
 * - System administration tasks
 *
 * @example
 * ```typescript
 * // Restrict organisation creation to super admins only
 * app.post("/organisations", requireAuth, requireSuperAdmin, handler);
 *
 * // Platform settings (super admin only)
 * app.put("/system/settings", requireAuth, requireSuperAdmin, handler);
 * ```
 */
export const requireSuperAdmin = createMiddleware(async (c, next) => {
  const user = c.get("user");

  if (!isSuperAdmin(user.email)) {
    return c.json({ error: "Super admin access required" }, 403);
  }

  await next();
});

/**
 * Helper function to check if a user is a super admin.
 * Exported for use in route handlers that need to conditionally apply
 * super admin logic (e.g., showing all organisations vs. user's organisations).
 *
 * @param userEmail - The email address to check
 * @returns True if the user is a super admin, false otherwise
 *
 * @example
 * ```typescript
 * import { isSuperAdmin } from "../middleware/authorization";
 *
 * // Conditionally filter results based on super admin status
 * if (isSuperAdmin(user.email)) {
 *   // Return all organisations
 *   return await db.select().from(organisationTable);
 * } else {
 *   // Return only user's organisations
 *   return await getUserOrganisations(user.id);
 * }
 * ```
 */
export { isSuperAdmin, isSuperAdminMembership };
