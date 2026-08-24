import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { mcp as mcpTable } from "../db/schema.ts";
import {
  mcpCreateSchema,
  mcpUpdateSchema,
  mcpTestSchema,
} from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess,
  workspaceCredentialsVisible,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import {
  mcpReadModel,
  sanitizeMcpResponse,
} from "../services/credential-redaction.ts";
import {
  listScoped,
  requireScoped,
  requireWorkspaceMutable,
  resolveScoped,
  workspaceScopedWhere,
} from "../services/scoped-resource.ts";
import type { Variables } from "../server.ts";

// MCP mutations introduce credentials and external reach, so they are
// org-admin by default and delegatable to the workspace owner via the
// `mcpSelfManagement` flag (ADR-0006). Reused across every mutating route.
const requireMcpConfigAccess =
  requireWorkspaceConfigAccess("mcpSelfManagement");
import {
  authorizeMcpOAuth,
  clearOAuthTokens,
  OAUTH_TOKEN_CLEAR_FIELDS,
  probeMcpConnection,
} from "../services/mcp-connection.ts";
import {
  assertMcpSlugAvailable,
  deriveMcpSlug,
} from "../services/mcp-namespace.ts";

const mcp = new Hono<{ Variables: Variables }>();

/** Create a new MCP (org-admin, or owner when delegated — ADR-0006) */
mcp.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  sValidator("json", mcpCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const { orgId, workspaceId } = workspaceScopeOf(c);
    const slug = deriveMcpSlug(data.name);
    await assertMcpSlugAvailable(slug, { orgId });
    const record = await db
      .insert(mcpTable)
      .values({
        id: nanoid(),
        ...data,
        slug,
        // The scope comes from the route, never the body — as it does for Agents
        // and Skills. Spreading the body let a caller name another Workspace, or
        // set `organizationId` and mint a Shared MCP from the Workspace surface,
        // which only an Org Admin may do (ADR-0006, ADR-0007).
        workspaceId,
        organizationId: null,
      })
      .returning();
    return c.json(sanitizeMcpResponse(record[0]), 201);
  },
);

/** List MCPs visible in this workspace (workspace-scoped + org-scoped) */
mcp.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    // Workspace-scoped MCPs plus the Shared (org-scoped) MCPs attached here
    // (ADR-0007), each tagged with its scope for the frontend.
    const scoped = await listScoped(db, "mcp", workspaceScopeOf(c));
    // Request credentials are revealed only to a caller who may manage this MCP
    // (ADR-0006) — the same rule the write routes reject on. The rows still list,
    // because granting an MCP to an Agent does not require self-management.
    const reveal = await workspaceCredentialsVisible(c, "mcp");
    const results = scoped.map(({ row, scope }) =>
      mcpReadModel(row, { reveal, scope }),
    );

    return c.json({ results });
  },
);

/** Get a MCP by ID (workspace-scoped or org-scoped) */
mcp.get(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const mcpId = c.req.param("mcpId");
    const found = await requireScoped(db, "mcp", mcpId, workspaceScopeOf(c));
    // See the list route: redacted unless this caller may manage the MCP.
    const reveal = await workspaceCredentialsVisible(c, "mcp");
    return c.json(mcpReadModel(found.row, { reveal, scope: found.scope }));
  },
);

/** Update a MCP by ID (org-admin, or owner when delegated — ADR-0006) */
mcp.put(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  sValidator("json", mcpUpdateSchema),
  async (c) => {
    const mcpId = c.req.param("mcpId");
    const scope = workspaceScopeOf(c);
    const data = c.req.valid("json");

    // A Shared MCP is a single source of truth edited only on the Organization
    // surface (ADR-0007); requireWorkspaceMutable throws NotFound (→404) when the
    // MCP is not visible here, then Locked (→403) when it is org-scoped. On
    // success the row is guaranteed Workspace-scoped.
    const { row } = await requireWorkspaceMutable(db, "mcp", mcpId, scope);

    // If the URL is changing, clear stored OAuth tokens (they're server-specific)
    const urlChanged = row.url !== data.url;

    const slug = deriveMcpSlug(data.name);
    await assertMcpSlugAvailable(slug, { orgId: scope.orgId }, mcpId);

    const record = await db
      .update(mcpTable)
      .set({
        ...data,
        slug,
        ...(urlChanged && {
          ...OAUTH_TOKEN_CLEAR_FIELDS,
          oauthClientId: null,
          oauthClientSecret: null,
        }),
        updatedAt: new Date(),
      })
      .where(workspaceScopedWhere("mcp", mcpId, scope.workspaceId))
      .returning();
    return c.json(sanitizeMcpResponse(record[0]), 200);
  },
);

/** Delete a MCP by ID (org-admin, or owner when delegated — ADR-0006) */
mcp.delete(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  async (c) => {
    const mcpId = c.req.param("mcpId");
    const scope = workspaceScopeOf(c);

    // A Shared MCP is deleted only from the Organization surface (ADR-0007):
    // requireWorkspaceMutable throws NotFound (→404) when the MCP is not visible
    // here, then Locked (→403) when it is org-scoped.
    await requireWorkspaceMutable(db, "mcp", mcpId, scope);

    await db
      .delete(mcpTable)
      .where(workspaceScopedWhere("mcp", mcpId, scope.workspaceId))
      .returning();
    return c.json({ message: "MCP deleted" });
  },
);

/**
 * Test MCP connection (org-admin, or owner when delegated — ADR-0006).
 * Read-only, so an attached Shared MCP is resolved through the Scoped-resource
 * authority the same as any other visible row (see mcp-connection.ts's
 * docstring for the full rationale).
 */
mcp.post(
  "/test",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  sValidator("json", mcpTestSchema),
  async (c) => {
    const data = c.req.valid("json");
    const scope = workspaceScopeOf(c);

    let storedMcp = null;
    if (data.authType === "OAuth" && data.mcpId) {
      const found = await resolveScoped(db, "mcp", data.mcpId, scope);
      storedMcp = found?.row ?? null;
    }

    const result = await probeMcpConnection(data, storedMcp);
    if (!result.success) {
      return c.json({ success: false, error: result.error }, result.status);
    }
    return c.json(result, 200);
  },
);

/**
 * Initiate OAuth authorization for an MCP (org-admin, or delegated owner).
 * Mutates org-owned OAuth credentials, so the row is resolved with
 * `requireWorkspaceMutable`: an attached Shared MCP is locked (403) rather
 * than reported as not found (see mcp-connection.ts's docstring).
 */
mcp.post(
  "/:mcpId/oauth/authorize",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  async (c) => {
    const mcpId = c.req.param("mcpId");
    const scope = workspaceScopeOf(c);

    const { row: mcpRecord } = await requireWorkspaceMutable(
      db,
      "mcp",
      mcpId,
      scope,
    );

    const force = c.req.query("force") === "true";
    const result = await authorizeMcpOAuth(db, mcpRecord, {
      force,
      clearTokensWhere: workspaceScopedWhere("mcp", mcpId, scope.workspaceId),
    });

    if (result.kind === "error") {
      return c.json({ error: result.message }, result.status);
    }
    if (result.kind === "redirect") {
      return c.json({ authorizationUrl: result.authorizationUrl });
    }
    return c.json({ alreadyAuthorized: true });
  },
);

/**
 * Revoke OAuth tokens for an MCP (org-admin, or delegated owner). Mutates
 * org-owned OAuth credentials, so the row is resolved with
 * `requireWorkspaceMutable` — see the authorize route above.
 */
mcp.post(
  "/:mcpId/oauth/revoke",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  async (c) => {
    const mcpId = c.req.param("mcpId");
    const scope = workspaceScopeOf(c);

    await requireWorkspaceMutable(db, "mcp", mcpId, scope);
    await clearOAuthTokens(
      db,
      workspaceScopedWhere("mcp", mcpId, scope.workspaceId),
    );

    return c.json({ success: true });
  },
);

export { mcp };
