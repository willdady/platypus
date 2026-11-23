import { Hono } from "hono";
import { z } from "zod";
import { validate } from "../validate.ts";
import { db } from "../index.ts";
import {
  mcpCreateSchema,
  mcpListResponseSchema,
  mcpResponseSchema,
  mcpTestSchema,
  mcpStoredTestSchema,
  mcpUpdateSchema,
} from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess,
  userOf,
  workspaceCredentialsVisible,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import { mcpReadModel } from "../services/credential-redaction.ts";
import {
  listScoped,
  requireScoped,
  requireWorkspaceMutable,
  workspaceScopedWhere,
} from "../services/scoped-resource.ts";
import type { Variables } from "../server.ts";

const requireMcpConfigAccess =
  requireWorkspaceConfigAccess("mcpSelfManagement");
import {
  authorizeMcpOAuth,
  clearOAuthTokens,
  probeMcpConnection,
} from "../services/mcp-connection.ts";
import { createMcp, deleteMcp, updateMcp } from "../services/mcp-write.ts";
import { respond } from "../respond.ts";

const mcp = new Hono<{ Variables: Variables }>();

mcp.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  validate("json", mcpCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const scope = workspaceScopeOf(c);
    const row = await createMcp({ kind: "workspace", ctx: scope }, data);
    return respond(
      c,
      mcpResponseSchema,
      mcpReadModel(row, { reveal: true, scope: "workspace" }),
      201,
    );
  },
);

mcp.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const scoped = await listScoped(db, "mcp", workspaceScopeOf(c));
    const reveal = await workspaceCredentialsVisible(c, "mcp");
    const results = scoped.map(({ row, scope }) =>
      mcpReadModel(row, { reveal: reveal && scope === "workspace", scope }),
    );

    return respond(c, mcpListResponseSchema, { results });
  },
);

mcp.get(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const mcpId = c.req.param("mcpId");
    const found = await requireScoped(db, "mcp", mcpId, workspaceScopeOf(c));
    const reveal = await workspaceCredentialsVisible(c, "mcp");
    return respond(
      c,
      mcpResponseSchema,
      mcpReadModel(found.row, {
        reveal: reveal && found.scope === "workspace",
        scope: found.scope,
      }),
    );
  },
);

mcp.put(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  validate("json", mcpUpdateSchema),
  async (c) => {
    const mcpId = c.req.param("mcpId");
    const scope = workspaceScopeOf(c);
    const data = c.req.valid("json");

    const row = await updateMcp({ kind: "workspace", ctx: scope }, mcpId, data);
    return respond(
      c,
      mcpResponseSchema,
      mcpReadModel(row, { reveal: true, scope: "workspace" }),
      200,
    );
  },
);

mcp.delete(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  async (c) => {
    const mcpId = c.req.param("mcpId");
    const scope = workspaceScopeOf(c);

    await deleteMcp({ kind: "workspace", ctx: scope }, mcpId);
    return c.json({ message: "MCP deleted" });
  },
);

mcp.post(
  "/test",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  validate("json", mcpTestSchema),
  async (c) => {
    const result = await probeMcpConnection(c.req.valid("json"), null);
    if (!result.success) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result, 200);
  },
);

mcp.post(
  "/:mcpId/test",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  validate("json", mcpStoredTestSchema),
  async (c) => {
    const scope = workspaceScopeOf(c);
    const { row } = await requireScoped(db, "mcp", c.req.param("mcpId"), scope);

    const result = await probeMcpConnection(c.req.valid("json"), row);
    if (!result.success) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result, 200);
  },
);

const oauthAuthorizeQuerySchema = z.strictObject({
  force: z.enum(["true", "false"]).optional(),
});

mcp.post(
  "/:mcpId/oauth/authorize",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireMcpConfigAccess,
  validate("query", oauthAuthorizeQuerySchema),
  async (c) => {
    const mcpId = c.req.param("mcpId");
    const scope = workspaceScopeOf(c);

    const { row: mcpRecord } = await requireWorkspaceMutable(
      db,
      "mcp",
      mcpId,
      scope,
    );

    const { force } = c.req.valid("query");
    const result = await authorizeMcpOAuth(db, mcpRecord, {
      force: force === "true",
      clearTokensWhere: workspaceScopedWhere("mcp", mcpId, scope.workspaceId),
      userId: userOf(c).id,
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
      { dropRegisteredClient: false },
    );

    return c.json({ message: "OAuth authorization revoked" });
  },
);

export { mcp };
