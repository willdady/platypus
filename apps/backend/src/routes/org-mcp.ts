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
  orgCredentialsVisible,
  orgScopeOf,
  requireOrgAccess,
} from "../middleware/authorization.ts";
import { scrubDeletedAgentReference } from "../services/agent-references.ts";
import {
  listOrgScoped,
  orgScopedWhere,
  requireOrgScoped,
  resolveOrgScoped,
  requireSharedDeletable,
} from "../services/scoped-resource.ts";
import type { Variables } from "../server.ts";
import {
  authorizeMcpOAuth,
  clearOAuthTokens,
  OAUTH_TOKEN_CLEAR_FIELDS,
  probeMcpConnection,
} from "../services/mcp-connection.ts";
import {
  mcpReadModel,
  sanitizeMcpResponse,
} from "../services/credential-redaction.ts";
import { NotFoundError } from "../errors.ts";
import {
  assertMcpSlugAvailable,
  deriveMcpSlug,
} from "../services/mcp-namespace.ts";

// Org-scoped MCPs are Shared resources (ADR-0007). They introduce credentials
// and external reach, so all mutations are org-admin-only (ADR-0006) — there is
// no per-workspace delegation at org scope.
const orgMcp = new Hono<{ Variables: Variables }>();

/** Create an org-scoped MCP (admin only) */
orgMcp.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", mcpCreateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const data = c.req.valid("json");

    const slug = deriveMcpSlug(data.name);
    await assertMcpSlugAvailable(slug, { orgId });

    // A duplicate name surfaces as a Postgres unique violation, mapped to 409
    // by the central onError (ADR-0010).
    const record = await db
      .insert(mcpTable)
      .values({
        id: nanoid(),
        ...data,
        slug,
        organizationId: orgId,
        workspaceId: null,
      })
      .returning();
    return c.json(sanitizeMcpResponse(record[0]), 201);
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
  sValidator("json", mcpUpdateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const mcpId = c.req.param("mcpId");
    const data = c.req.valid("json");

    // If URL is changing, clear stored OAuth tokens (they're server-specific)
    const existing = await resolveOrgScoped(db, "mcp", mcpId, orgId);

    const urlChanged = !!existing && existing.url !== data.url;

    const slug = deriveMcpSlug(data.name);
    await assertMcpSlugAvailable(slug, { orgId }, mcpId);

    // A duplicate name surfaces as a Postgres unique violation, mapped to 409
    // by the central onError (ADR-0010).
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
      .where(orgScopedWhere("mcp", mcpId, orgId))
      .returning();
    if (record.length === 0) {
      throw new NotFoundError("MCP not found");
    }
    return c.json(sanitizeMcpResponse(record[0]), 200);
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

    // A Shared resource cannot be deleted while anything still points at it —
    // an Attachment (ADR-0007) or a Blueprint (ADR-0008). Throws ConflictError
    // → 409 via the central onError (ADR-0010).
    await requireSharedDeletable(db, "mcp", mcpId);

    // Delete the MCP and scrub its (now-dead) id from any Agent's toolSetIds in
    // the same transaction, so deletion never leaves dangling references.
    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .delete(mcpTable)
        .where(orgScopedWhere("mcp", mcpId, orgId))
        .returning();
      if (rows.length > 0) {
        await scrubDeletedAgentReference(tx, "toolSetIds", mcpId);
      }
      return rows;
    });
    if (result.length === 0) {
      throw new NotFoundError("MCP not found");
    }
    return c.json({ message: "MCP deleted" });
  },
);

/** Test an org-scoped MCP connection (admin only) */
orgMcp.post(
  "/test",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", mcpTestSchema),
  async (c) => {
    const data = c.req.valid("json");
    const { orgId } = orgScopeOf(c);

    const storedMcp =
      data.authType === "OAuth" && data.mcpId
        ? await resolveOrgScoped(db, "mcp", data.mcpId, orgId)
        : null;

    const result = await probeMcpConnection(data, storedMcp);
    if (!result.success) {
      return c.json({ success: false, error: result.error }, result.status);
    }
    return c.json(result, 200);
  },
);

/** Initiate OAuth authorization for an org-scoped MCP (admin only) */
orgMcp.post(
  "/:mcpId/oauth/authorize",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const mcpId = c.req.param("mcpId");

    const mcpRecord = await requireOrgScoped(db, "mcp", mcpId, orgId);

    const force = c.req.query("force") === "true";
    const result = await authorizeMcpOAuth(db, mcpRecord, {
      force,
      clearTokensWhere: orgScopedWhere("mcp", mcpId, orgId),
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

    return c.json({ success: true });
  },
);

export { orgMcp };
