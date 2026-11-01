import { Hono } from "hono";
import { z } from "zod";
import { validate } from "../validate.ts";
import { db } from "../index.ts";
import {
  mcpCreateSchema,
  mcpUpdateSchema,
  mcpTestSchema,
  mcpStoredTestSchema,
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
import {
  mcpReadModel,
  sanitizeMcpResponse,
} from "../services/credential-redaction.ts";
import { createMcp, deleteMcp, updateMcp } from "../services/mcp-write.ts";

// Org-scoped MCPs are Shared resources (ADR-0007). They introduce credentials
// and external reach, so all mutations are org-admin-only (ADR-0006) — there is
// no per-workspace delegation at org scope.
const orgMcp = new Hono<{ Variables: Variables }>();

/** Create an org-scoped MCP (admin only) */
orgMcp.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", mcpCreateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const data = c.req.valid("json");

    // A duplicate name surfaces as a Postgres unique violation, mapped to 409
    // by the central onError (ADR-0010).
    const row = await createMcp({ kind: "organization", orgId }, data);
    return c.json(sanitizeMcpResponse(row), 201);
  },
);

/** List org-scoped MCPs */
orgMcp.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const results = await listOrgScoped(db, "mcp", orgId);
  // This route admits any Organization member — a Shared MCP has to be listable
  // to be granted. Only an Org Admin sees its request credentials (ADR-0006).
  const reveal = orgCredentialsVisible(c);
  return c.json({
    results: results.map((row) => mcpReadModel(row, { reveal })),
  });
});

/** Get an org-scoped MCP by ID */
orgMcp.get("/:mcpId", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const mcpId = c.req.param("mcpId");
  const record = await requireOrgScoped(db, "mcp", mcpId, orgId);
  // See the list route: request credentials are Org-Admin-only (ADR-0006).
  const reveal = orgCredentialsVisible(c);
  return c.json(mcpReadModel(record, { reveal }));
});

/** Update an org-scoped MCP by ID (admin only) */
orgMcp.put(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", mcpUpdateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const mcpId = c.req.param("mcpId");
    const data = c.req.valid("json");

    // A duplicate name surfaces as a Postgres unique violation, mapped to 409
    // by the central onError (ADR-0010).
    const row = await updateMcp({ kind: "organization", orgId }, mcpId, data);
    return c.json(sanitizeMcpResponse(row), 200);
  },
);

/** Delete an org-scoped MCP by ID (admin only) */
orgMcp.delete(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const mcpId = c.req.param("mcpId");

    // Throws ConflictError (→409) while an Attachment or Blueprint still
    // references the MCP (ADR-0007/0008), and scrubs its (now-dead) id from
    // any Agent's toolSetIds in the same transaction as the delete.
    await deleteMcp({ kind: "organization", orgId }, mcpId);
    return c.json({ message: "MCP deleted" });
  },
);

/** Test an unsaved org-scoped MCP connection (admin only) */
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

/** Test a stored org-scoped MCP connection, addressed by its id (admin only) */
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

/** Initiate OAuth authorization for an org-scoped MCP (admin only) */
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

/** Revoke OAuth tokens for an org-scoped MCP (admin only) */
orgMcp.post(
  "/:mcpId/oauth/revoke",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const mcpId = c.req.param("mcpId");

    await requireOrgScoped(db, "mcp", mcpId, orgId);
    await clearOAuthTokens(db, orgScopedWhere("mcp", mcpId, orgId));

    return c.json({ message: "OAuth authorization revoked" });
  },
);

export { orgMcp };
