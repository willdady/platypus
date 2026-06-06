import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./index.ts";
import { auth } from "./auth.ts";
import { chat } from "./routes/chat.ts";
import { files } from "./routes/files.ts";
import { organization } from "./routes/organization.ts";
import { workspace } from "./routes/workspace.ts";
import { agent } from "./routes/agent.ts";
import { skill } from "./routes/skill.ts";
import { tool } from "./routes/tool.ts";
import { mcp } from "./routes/mcp.ts";
import { sandbox } from "./routes/sandbox.ts";
import "./sandbox/backends/index.ts";
import { provider } from "./routes/provider.ts";
import { orgProvider } from "./routes/org-provider.ts";
import { orgMcp } from "./routes/org-mcp.ts";
import { orgSkill } from "./routes/org-skill.ts";
import { orgAgent } from "./routes/org-agent.ts";
import { orgTool } from "./routes/org-tool.ts";
import { orgAttachment } from "./routes/org-attachment.ts";
import { orgBlueprint } from "./routes/org-blueprint.ts";
import { attachment } from "./routes/attachment.ts";
import { invitation } from "./routes/invitation.ts";
import { userInvitation } from "./routes/user-invitation.ts";
import { member } from "./routes/member.ts";
import { context } from "./routes/context.ts";
import { trigger } from "./routes/trigger.ts";
import { kanban } from "./routes/kanban.ts";
import { dashboard } from "./routes/dashboard.ts";
import { notification } from "./routes/notification.ts";
import { webhook } from "./routes/webhook.ts";
import { mcpOauthCallback } from "./routes/mcp-oauth-callback.ts";
import { organizationMember } from "./db/schema.ts";
import { logger } from "./logger.ts";
import type { UserScope, OrgScope, WorkspaceScope } from "./scope.ts";

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
 * Valid organization roles.
 * - admin: Can manage the organization and all workspaces within it
 * - member: Regular member who creates and owns their own workspaces
 */
export type OrgRole = "admin" | "member";

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
   * Whether the current user owns the workspace (set by requireWorkspaceAccess middleware).
   */
  isWorkspaceOwner?: boolean;

  /**
   * User-level scope (set by requireAuth middleware).
   * Carries the Principal identifying who is executing the request.
   */
  userScope?: UserScope;

  /**
   * Organization-level scope (set by requireOrgAccess middleware).
   * Extends UserScope with orgId.
   */
  orgScope?: OrgScope;

  /**
   * Workspace-level scope (set by requireWorkspaceAccess middleware).
   * Extends OrgScope with workspaceId and isWorkspaceOwner.
   */
  workspaceScope?: WorkspaceScope;
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

app.route("/files", files);
app.route("/organizations", organization);
app.route("/organizations/:orgId/workspaces", workspace);
app.route("/organizations/:orgId/workspaces/:workspaceId/agents", agent);
app.route("/organizations/:orgId/workspaces/:workspaceId/chat", chat);
app.route("/organizations/:orgId/workspaces/:workspaceId/mcps", mcp);
app.route("/organizations/:orgId/workspaces/:workspaceId/sandbox", sandbox);
app.route("/organizations/:orgId/workspaces/:workspaceId/skills", skill);
app.route("/organizations/:orgId/workspaces/:workspaceId/providers", provider);
app.route("/organizations/:orgId/providers", orgProvider);
app.route("/organizations/:orgId/mcps", orgMcp);
app.route("/organizations/:orgId/skills", orgSkill);
app.route("/organizations/:orgId/agents", orgAgent);
app.route("/organizations/:orgId/tools", orgTool);
app.route("/organizations/:orgId/attachments", orgAttachment);
app.route("/organizations/:orgId/blueprints", orgBlueprint);
app.route(
  "/organizations/:orgId/workspaces/:workspaceId/attachments",
  attachment,
);
app.route("/organizations/:orgId/workspaces/:workspaceId/tools", tool);
app.route("/organizations/:orgId/workspaces/:workspaceId/triggers", trigger);
app.route("/organizations/:orgId/workspaces/:workspaceId/boards", kanban);
app.route(
  "/organizations/:orgId/workspaces/:workspaceId/dashboards",
  dashboard,
);
app.route(
  "/organizations/:orgId/workspaces/:workspaceId/notifications",
  notification,
);
app.route("/organizations/:orgId/workspaces/:workspaceId/webhooks", webhook);
app.route("/organizations/:orgId/invitations", invitation);
app.route("/organizations/:orgId/members", member);
app.route("/users/me/invitations", userInvitation);
app.route("/users/me/contexts", context);
app.route("/oauth/mcp/callback", mcpOauthCallback);

export default app;
