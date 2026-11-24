import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { db } from "./index.ts";
import { auth } from "./auth.ts";
import { authBaseUrl } from "./base-urls.ts";
import { requireInvitationToSignUp } from "./sign-up.ts";
import { chat } from "./routes/chat.ts";
import { files } from "./routes/files.ts";
import { organization } from "./routes/organization.ts";
import { workspace } from "./routes/workspace.ts";
import { agent } from "./routes/agent.ts";
import { skill } from "./routes/skill.ts";
import { tool } from "./routes/tool.ts";
import { mcp } from "./routes/mcp.ts";
import { sandbox } from "./routes/sandbox.ts";
import { provider } from "./routes/provider.ts";
import { orgProvider } from "./routes/org-provider.ts";
import { orgMcp } from "./routes/org-mcp.ts";
import { orgSkill, orgSkillImport } from "./routes/org-skill.ts";
import { orgAgent } from "./routes/org-agent.ts";
import { orgTool } from "./routes/org-tool.ts";
import { orgAttachment } from "./routes/org-attachment.ts";
import { orgBlueprint } from "./routes/org-blueprint.ts";
import { attachment } from "./routes/attachment.ts";
import { invitation } from "./routes/invitation.ts";
import { invitationLink } from "./routes/invitation-link.ts";
import { userInvitation } from "./routes/user-invitation.ts";
import { member } from "./routes/member.ts";
import { context } from "./routes/context.ts";
import { trigger } from "./routes/trigger.ts";
import { triggerRun } from "./routes/trigger-run.ts";
import { kanban } from "./routes/kanban.ts";
import { artifacts } from "./routes/artifacts.ts";
import { notification } from "./routes/notification.ts";
import { webhook } from "./routes/webhook.ts";
import { mcpOauthCallback } from "./routes/mcp-oauth-callback.ts";
import { plugins } from "./routes/plugins.ts";
import { webBackends } from "./routes/web-backends.ts";
import { sandboxBackends } from "./routes/sandbox-backends.ts";
import { hooks } from "./routes/hooks.ts";
import { orgInboundTrigger } from "./routes/org-inbound-trigger.ts";
import { a2a } from "./routes/a2a.ts";
import { a2aEndpoint } from "./routes/a2a-endpoint.ts";
import { orgA2a } from "./routes/org-a2a.ts";
import type { organizationMember } from "./db/schema.ts";
import { logger } from "./logger.ts";
import { readyRoutes } from "./ready.ts";
import { mapError } from "./errors.ts";
import type { OrgScope, WorkspaceScope } from "./scope.ts";
import { env } from "./env.ts";

export type OrganizationMembership = typeof organizationMember.$inferSelect;

export type SuperAdminOrgMembership = {
  role: "admin";
  isSuperAdmin: true;
};

export type { OrgRole } from "@platypus/schemas";

export type Variables = {
  user?: typeof auth.$Infer.Session.user;

  orgMembership?: OrganizationMembership | SuperAdminOrgMembership;

  orgScope?: OrgScope;

  workspaceScope?: WorkspaceScope;
};

const app = new Hono<{ Variables: Variables }>();

app.use(
  "/*",
  cors({
    origin: env().ALLOWED_ORIGINS,
    credentials: true,
  }),
);

app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const fields = {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration: `${ms}ms`,
  };
  if (c.req.path === "/health") {
    logger.debug(fields, "Request processed");
  } else {
    logger.info(fields, "Request processed");
  }
});

const authPath = new URL(authBaseUrl()).pathname;
app.on(["POST", "GET"], "/auth/*", (c) => {
  const url = new URL(c.req.url);
  url.pathname = authPath + url.pathname.slice("/auth".length);
  const raw = c.req.raw;
  return auth.handler(
    new Request(url, {
      method: raw.method,
      headers: raw.headers,
      body: raw.body,
      duplex: "half",
      signal: raw.signal,
    } as RequestInit),
  );
});

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/", readyRoutes({ query: (query) => db.$client.query(query) }));
app.get("/sign-up", (c) => c.json({ open: !requireInvitationToSignUp() }));

app.route("/hooks", hooks);
app.route("/a2a", a2a);
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
app.route("/organizations/:orgId/skill-import", orgSkillImport);
app.route("/organizations/:orgId/agents", orgAgent);
app.route("/organizations/:orgId/tools", orgTool);
app.route("/organizations/:orgId/attachments", orgAttachment);
app.route("/organizations/:orgId/blueprints", orgBlueprint);
app.route("/organizations/:orgId/inbound-triggers", orgInboundTrigger);
app.route("/organizations/:orgId/a2a", orgA2a);
app.route(
  "/organizations/:orgId/workspaces/:workspaceId/attachments",
  attachment,
);
app.route("/organizations/:orgId/workspaces/:workspaceId/tools", tool);
app.route("/organizations/:orgId/workspaces/:workspaceId/triggers", trigger);
app.route(
  "/organizations/:orgId/workspaces/:workspaceId/trigger-runs",
  triggerRun,
);
app.route("/organizations/:orgId/workspaces/:workspaceId/boards", kanban);
app.route("/organizations/:orgId/workspaces/:workspaceId/artifacts", artifacts);
app.route(
  "/organizations/:orgId/workspaces/:workspaceId/notifications",
  notification,
);
app.route("/organizations/:orgId/workspaces/:workspaceId/webhooks", webhook);
app.route(
  "/organizations/:orgId/workspaces/:workspaceId/a2a-endpoints",
  a2aEndpoint,
);
app.route("/organizations/:orgId/invitations", invitation);
app.route("/invitation-links", invitationLink);
app.route("/organizations/:orgId/members", member);
app.route("/users/me/invitations", userInvitation);
app.route("/users/me/contexts", context);
app.route("/oauth/mcp/callback", mcpOauthCallback);
app.route("/organizations/:orgId/plugins", plugins);
app.route("/organizations/:orgId/web-backends", webBackends);
app.route("/organizations/:orgId/sandbox-backends", sandboxBackends);

app.notFound((c) => c.json({ error: "Not Found" }, 404));

app.onError((error, c) => {
  if (error instanceof HTTPException && error.status < 500) {
    return c.json({ error: error.message }, error.status);
  }
  const mapped = mapError(error);
  if (mapped) {
    return c.json(
      {
        error: mapped.issues ?? mapped.message,
        ...(mapped.files && { files: mapped.files }),
      },
      mapped.status,
    );
  }
  logger.error({ error }, "Unhandled error");
  return c.json({ error: "Internal Server Error" }, 500);
});

export default app;
