import { createMiddleware } from "hono/factory";
import { auth } from "../auth.ts";

/**
 * Middleware that validates user authentication via session.
 *
 * **Purpose:**
 * Ensures that the request has a valid authenticated session before allowing
 * access to protected routes. This is the base authentication check that should
 * be applied before any authorization checks.
 *
 * **Behavior:**
 * - Validates the session using better-auth's session API
 * - Returns 401 Unauthorized if no valid session exists
 * - Sets `user` and `session` in the Hono context for use by subsequent middleware/handlers
 * - Allows the request to proceed if authentication is successful
 *
 * **Context Variables Set:**
 * - `user` - The authenticated user object from the session
 * - `session` - The session object containing session metadata
 *
 * **Usage:**
 * This middleware should be the first in the chain for protected routes,
 * before any authorization middleware (requireOrgAccess, requireWorkspaceAccess).
 *
 * @example
 * ```typescript
 * // Basic authentication check
 * app.get("/profile", requireAuth, handler);
 *
 * // Authentication + authorization
 * app.get("/organizations/:id", requireAuth, requireOrgAccess(), handler);
 *
 * // Multiple middleware in sequence
 * app.post("/workspaces/:workspaceId/agents",
 *   requireAuth,
 *   requireOrgAccess(),
 *   requireWorkspaceAccess(["admin", "editor"]),
 *   handler
 * );
 * ```
 */
export const requireAuth = createMiddleware(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", session.user);
  c.set("session", session.session);
  await next();
});
