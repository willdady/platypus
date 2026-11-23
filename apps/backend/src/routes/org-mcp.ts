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
  orgCredentialsVisible,
  orgScopeOf,
  requireOrgAccess,
  userOf,
} from "../middleware/authorization.ts";
import {
  listOrgScoped,
  orgScopedWhere,
  requireOrgScoped,
} from "../services/scoped-resource.ts";
import type { Variables } from "../server.ts";
import {
  authorizeMcpOAuth,
  clearOAuthTokens,
  probeMcpConnection,
} from "../services/mcp-connection.ts";
import { mcpReadModel } from "../services/credential-redaction.ts";
import { createMcp, deleteMcp, updateMcp } from "../services/mcp-write.ts";
import { respond } from "../respond.ts";

const orgMcp = new Hono<{ Variables: Variables }>();

orgMcp.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", mcpCreateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const data = c.req.valid("json");

    const row = await createMcp({ kind: "organization", orgId }, data);
    return respond(
      c,
      mcpResponseSchema,
      mcpReadModel(row, { reveal: true, scope: "organization" }),
      201,
    );
  },
);

orgMcp.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const results = await listOrgScoped(db, "mcp", orgId);
  const reveal = orgCredentialsVisible(c);
  return respond(c, mcpListResponseSchema, {
    results: results.map((row) =>
      mcpReadModel(row, { reveal, scope: "organization" }),
    ),
  });
});

orgMcp.get("/:mcpId", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const mcpId = c.req.param("mcpId");
  const record = await requireOrgScoped(db, "mcp", mcpId, orgId);
  const reveal = orgCredentialsVisible(c);
  return respond(
    c,
    mcpResponseSchema,
    mcpReadModel(record, { reveal, scope: "organization" }),
  );
});

orgMcp.put(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", mcpUpdateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const mcpId = c.req.param("mcpId");
    const data = c.req.valid("json");

    const row = await updateMcp({ kind: "organization", orgId }, mcpId, data);
    return respond(
      c,
      mcpResponseSchema,
      mcpReadModel(row, { reveal: true, scope: "organization" }),
      200,
    );
  },
);

orgMcp.delete(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const mcpId = c.req.param("mcpId");

    await deleteMcp({ kind: "organization", orgId }, mcpId);
    return c.json({ message: "MCP deleted" });
  },
);

orgMcp.post(
  "/test",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", mcpTestSchema),
  async (c) => {
    const result = await probeMcpConnection(c.req.valid("json"), null);
    if (!result.success) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result, 200);
  },
);

orgMcp.post(
  "/:mcpId/test",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", mcpStoredTestSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const storedMcp = await requireOrgScoped(
      db,
      "mcp",
      c.req.param("mcpId"),
      orgId,
    );

    const result = await probeMcpConnection(c.req.valid("json"), storedMcp);
    if (!result.success) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result, 200);
  },
);

const oauthAuthorizeQuerySchema = z.strictObject({
  force: z.enum(["true", "false"]).optional(),
});

orgMcp.post(
  "/:mcpId/oauth/authorize",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("query", oauthAuthorizeQuerySchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const mcpId = c.req.param("mcpId");

    const mcpRecord = await requireOrgScoped(db, "mcp", mcpId, orgId);

    const { force } = c.req.valid("query");
    const result = await authorizeMcpOAuth(db, mcpRecord, {
      force: force === "true",
      clearTokensWhere: orgScopedWhere("mcp", mcpId, orgId),
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

orgMcp.post(
  "/:mcpId/oauth/revoke",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const mcpId = c.req.param("mcpId");

    await requireOrgScoped(db, "mcp", mcpId, orgId);
    await clearOAuthTokens(db, orgScopedWhere("mcp", mcpId, orgId), {
      dropRegisteredClient: false,
    });

    return c.json({ message: "OAuth authorization revoked" });
  },
);

export { orgMcp };
