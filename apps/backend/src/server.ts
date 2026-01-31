import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./index.ts";
import { auth } from "./auth.ts";
import { chat } from "./routes/chat.ts";
import { organization } from "./routes/organization.ts";
import { workspace } from "./routes/workspace.ts";
import { agent } from "./routes/agent.ts";
import { skill } from "./routes/skill.ts";
import { tool } from "./routes/tool.ts";
import { mcp } from "./routes/mcp.ts";
import { provider } from "./routes/provider.ts";
import { orgProvider } from "./routes/org-provider.ts";
import { invitation } from "./routes/invitation.ts";
import { userInvitation } from "./routes/user-invitation.ts";
import { member } from "./routes/member.ts";
import { context } from "./routes/context.ts";
import { organizationMember, workspaceMember } from "./db/schema.ts";
import { logger } from "./logger.ts";

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS!.split(",");

/**
 * Organization membership type inferred from the database schema.
 * Represents a user's membership and role within an organization.
 */
export type OrganizationMembership = typeof organizationMember.$inferSelect;

/**
 * Organization membership with super admin flag.
 * Used when a super admin accesses an organization (bypasses normal membership checks).
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
 * Valid organization roles.
 * - admin: Can manage the organization and all workspaces within it
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
   * Organization membership data (set by requireOrgAccess middleware).
   * Can be either regular membership or super admin membership.
   */
  orgMembership?: OrganizationMembership | SuperAdminOrgMembership;

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

app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  logger.info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration: `${ms}ms`,
    },
    "Request processed",
  );
});

// Auth routes - must be before the db middleware
app.on(["POST", "GET"], "/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

app.use("*", async (c, next) => {
  c.set("db", db);
  await next();
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/organizations", organization);
app.route("/organizations/:orgId/workspaces", workspace);
app.route("/organizations/:orgId/workspaces/:workspaceId/agents", agent);
app.route("/organizations/:orgId/workspaces/:workspaceId/chat", chat);
app.route("/organizations/:orgId/workspaces/:workspaceId/mcps", mcp);
app.route("/organizations/:orgId/workspaces/:workspaceId/skills", skill);
app.route("/organizations/:orgId/workspaces/:workspaceId/providers", provider);
app.route("/organizations/:orgId/providers", orgProvider);
app.route("/organizations/:orgId/workspaces/:workspaceId/tools", tool);
app.route("/organizations/:orgId/invitations", invitation);
app.route("/organizations/:orgId/members", member);
app.route("/users/me/invitations", userInvitation);
app.route("/users/me/contexts", context);

export default app;
