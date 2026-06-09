import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import {
  experimental_createMCPClient as createMCPClient,
  auth as mcpAuth,
} from "@ai-sdk/mcp";
import { db } from "../index.ts";
import { mcp as mcpTable } from "../db/schema.ts";
import {
  mcpCreateSchema,
  mcpUpdateSchema,
  mcpTestSchema,
} from "@platypus/schemas";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess } from "../middleware/authorization.ts";
import { scrubDeletedAgentReference } from "../services/agent-references.ts";
import { requireSharedDeletable } from "../services/scoped-resource.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";
import {
  DatabaseOAuthClientProvider,
  oauthFetchFn,
  buildOAuthCallbackUrl,
  buildMcpTransportConfig,
} from "../services/mcp-oauth-provider.ts";
import { OAUTH_TOKEN_CLEAR_FIELDS, sanitizeMcpResponse } from "./mcp.ts";
import { NotFoundError } from "../errors.ts";

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
    const orgId = c.req.param("orgId")!;
    const data = c.req.valid("json");

    // A duplicate name surfaces as a Postgres unique violation, mapped to 409
    // by the central onError (ADR-0010).
    const record = await db
      .insert(mcpTable)
      .values({
        id: nanoid(),
        ...data,
        organizationId: orgId,
        workspaceId: null,
      })
      .returning();
    return c.json(sanitizeMcpResponse(record[0]), 201);
  },
);

/** List org-scoped MCPs */
orgMcp.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const orgId = c.req.param("orgId")!;
  const results = await db
    .select()
    .from(mcpTable)
    .where(eq(mcpTable.organizationId, orgId));
  return c.json({ results: results.map(sanitizeMcpResponse) });
});

/** Get an org-scoped MCP by ID */
orgMcp.get("/:mcpId", requireAuth, requireOrgAccess(), async (c) => {
  const orgId = c.req.param("orgId")!;
  const mcpId = c.req.param("mcpId");
  const record = await db
    .select()
    .from(mcpTable)
    .where(and(eq(mcpTable.id, mcpId), eq(mcpTable.organizationId, orgId)))
    .limit(1);
  if (record.length === 0) {
    throw new NotFoundError("MCP not found");
  }
  return c.json(sanitizeMcpResponse(record[0]));
});

/** Update an org-scoped MCP by ID (admin only) */
orgMcp.put(
  "/:mcpId",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", mcpUpdateSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const mcpId = c.req.param("mcpId");
    const data = c.req.valid("json");

    // If URL is changing, clear stored OAuth tokens (they're server-specific)
    const existing = await db
      .select()
      .from(mcpTable)
      .where(and(eq(mcpTable.id, mcpId), eq(mcpTable.organizationId, orgId)))
      .limit(1);

    const urlChanged = existing.length > 0 && existing[0].url !== data.url;

    // A duplicate name surfaces as a Postgres unique violation, mapped to 409
    // by the central onError (ADR-0010).
    const record = await db
      .update(mcpTable)
      .set({
        ...data,
        ...(urlChanged && {
          ...OAUTH_TOKEN_CLEAR_FIELDS,
          oauthClientId: null,
          oauthClientSecret: null,
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(mcpTable.id, mcpId), eq(mcpTable.organizationId, orgId)))
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
    const orgId = c.req.param("orgId")!;
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
        .where(and(eq(mcpTable.id, mcpId), eq(mcpTable.organizationId, orgId)))
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

    let mcpClient;
    try {
      // For OAuth, use authProvider with stored tokens
      if (data.authType === "OAuth" && data.mcpId) {
        const orgId = c.req.param("orgId")!;
        const mcpRecord = await db
          .select()
          .from(mcpTable)
          .where(
            and(
              eq(mcpTable.id, data.mcpId),
              eq(mcpTable.organizationId, orgId),
            ),
          )
          .limit(1);

        if (mcpRecord.length === 0) {
          return c.json({ success: false, error: "MCP not found" }, 404);
        }

        if (!mcpRecord[0].oauthAccessToken) {
          return c.json(
            {
              success: false,
              error: "MCP not yet authorized. Click Authorize first.",
            },
            400,
          );
        }

        mcpClient = await createMCPClient({
          transport: buildMcpTransportConfig(mcpRecord[0]),
        });
      } else {
        mcpClient = await createMCPClient({
          transport: {
            type: "http",
            url: data.url,
            headers: {
              ...data.headers,
              ...(data.authType === "Bearer"
                ? { Authorization: `Bearer ${data.bearerToken}` }
                : {}),
            },
          },
        });
      }

      const mcpTools = await mcpClient.tools();
      const toolNames = Object.keys(mcpTools);
      await mcpClient.close();

      return c.json({ success: true, toolNames }, 200);
    } catch (error) {
      if (mcpClient) {
        try {
          await mcpClient.close();
        } catch (closeError) {
          logger.error({ error: closeError }, "Error closing MCP client");
        }
      }

      logger.error({ error }, "MCP test connection error");

      let errorMessage = "Unknown error connecting to MCP server";
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === "string") {
        errorMessage = error;
      }

      return c.json({ success: false, error: errorMessage }, 400);
    }
  },
);

/** Initiate OAuth authorization for an org-scoped MCP (admin only) */
orgMcp.post(
  "/:mcpId/oauth/authorize",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const mcpId = c.req.param("mcpId");

    const mcpRecord = await db
      .select()
      .from(mcpTable)
      .where(and(eq(mcpTable.id, mcpId), eq(mcpTable.organizationId, orgId)))
      .limit(1);

    if (mcpRecord.length === 0) {
      return c.json({ error: "MCP not found" }, 404);
    }

    if (mcpRecord[0].authType !== "OAuth") {
      return c.json({ error: "MCP auth type is not OAuth" }, 400);
    }

    if (!mcpRecord[0].url) {
      return c.json({ error: "MCP URL is not configured" }, 400);
    }
    // Capture the narrowed URL before the `force` block reassigns
    // `mcpRecord[0]`, which widens the property back to `string | null`.
    const serverUrl = mcpRecord[0].url;

    // `force=true` clears stored tokens before the OAuth flow so mcpAuth always
    // returns REDIRECT (see mcp.ts for the full rationale). DCR/static client
    // credentials are preserved so the same OAuth client is reused.
    const force = c.req.query("force") === "true";
    if (force) {
      await db
        .update(mcpTable)
        .set({ ...OAUTH_TOKEN_CLEAR_FIELDS, updatedAt: new Date() })
        .where(eq(mcpTable.id, mcpId));
      mcpRecord[0] = { ...mcpRecord[0], ...OAUTH_TOKEN_CLEAR_FIELDS };
    }

    try {
      const callbackUrl = buildOAuthCallbackUrl();
      const provider = new DatabaseOAuthClientProvider(
        mcpRecord[0],
        callbackUrl,
      );

      const result = await mcpAuth(provider, {
        serverUrl,
        fetchFn: oauthFetchFn,
      });

      if (result === "REDIRECT") {
        const authUrl = provider.getPendingAuthUrl();
        if (!authUrl) {
          return c.json({ error: "Failed to generate authorization URL" }, 500);
        }
        return c.json({ authorizationUrl: authUrl.toString() });
      }

      return c.json({ alreadyAuthorized: true });
    } catch (error) {
      logger.error({ error }, "OAuth authorize error");
      const errorMessage =
        error instanceof Error ? error.message : "OAuth authorization failed";
      return c.json({ error: errorMessage }, 500);
    }
  },
);

/** Revoke OAuth tokens for an org-scoped MCP (admin only) */
orgMcp.post(
  "/:mcpId/oauth/revoke",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const mcpId = c.req.param("mcpId");

    const record = await db
      .update(mcpTable)
      .set({ ...OAUTH_TOKEN_CLEAR_FIELDS, updatedAt: new Date() })
      .where(and(eq(mcpTable.id, mcpId), eq(mcpTable.organizationId, orgId)))
      .returning();

    if (record.length === 0) {
      return c.json({ error: "MCP not found" }, 404);
    }

    return c.json({ success: true });
  },
);

export { orgMcp };
