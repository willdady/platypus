import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./index.ts";
import { auth } from "./auth.ts";
import { chat } from "./routes/chat.ts";
import { organisation } from "./routes/organisation.ts";
import { workspace } from "./routes/workspace.ts";
import { agent } from "./routes/agent.ts";
import { tool } from "./routes/tool.ts";
import { mcp } from "./routes/mcp.ts";
import { provider } from "./routes/provider.ts";
import { invitation } from "./routes/invitation.ts";
import { userInvitation } from "./routes/user-invitation.ts";
import { organisationMember, workspaceMember } from "./db/schema.ts";

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS!.split(",");

/**
 * Organisation membership type inferred from the database schema.
 * Represents a user's membership and role within an organisation.
 */
export type OrganisationMembership = typeof organisationMember.$inferSelect;

/**
 * Organisation membership with super admin flag.
 * Used when a super admin accesses an organisation (bypasses normal membership checks).
 */
export type SuperAdminOrgMembership = {
  role: "admin";
  isSuperAdmin: true;
};

/**
 * Workspace membership type inferred from the database schema.
 * Represents a user's explicit membership and role within a workspace.
 */
export type WorkspaceMembership = typeof workspaceMember.$inferSelect;

/**
 * Valid organisation roles.
 * - admin: Can manage the organisation and all workspaces within it
 * - member: Regular member who needs explicit workspace access
 */
export type OrgRole = "admin" | "member";

/**
 * Valid workspace roles in hierarchical order: admin > editor > viewer
 */
export type WorkspaceRole = "admin" | "editor" | "viewer";

/**
 * Hono context variables available throughout the request lifecycle.
 * These are set by various middleware functions and can be accessed in route handlers.
 */
export type Variables = {
  /** Database instance for querying */
  db: typeof db;

  /** Authenticated user from session (set by requireAuth middleware) */
  user?: typeof auth.$Infer.Session.user;

  /** Session data (set by requireAuth middleware) */
  session?: typeof auth.$Infer.Session.session;

  /**
   * Organisation membership data (set by requireOrgAccess middleware).
   * Can be either regular membership or super admin membership.
   */
  orgMembership?: OrganisationMembership | SuperAdminOrgMembership;

  /**
   * Workspace membership data (set by requireWorkspaceAccess middleware).
   * Null for super admins and org admins (who have implicit access).
   */
  workspaceMembership?: WorkspaceMembership | null;

  /**
   * Effective workspace role (set by requireWorkspaceAccess middleware).
   * Computed based on super admin status, org admin status, or explicit workspace membership.
   */
  workspaceRole?: WorkspaceRole;
};

const app = new Hono<{ Variables: Variables }>();

app.use(
  "/*",
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true, // Important for cookies
  }),
);

// Auth routes - must be before the db middleware
app.on(["POST", "GET"], "/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

app.use("*", async (c, next) => {
  c.set("db", db);
  await next();
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/organisations", organisation);
app.route("/organisations/:orgId/workspaces", workspace);
app.route("/organisations/:orgId/workspaces/:workspaceId/agents", agent);
app.route("/organisations/:orgId/workspaces/:workspaceId/chat", chat);
app.route("/organisations/:orgId/workspaces/:workspaceId/mcps", mcp);
app.route("/organisations/:orgId/workspaces/:workspaceId/providers", provider);
app.route("/organisations/:orgId/workspaces/:workspaceId/tools", tool);
app.route("/organisations/:orgId/invitations", invitation);
app.route("/users/me/invitations", userInvitation);

export default app;
