import { Hono } from "hono";
import { validate } from "../validate.ts";
import { auth as mcpAuth } from "@ai-sdk/mcp";
import { db } from "../index.ts";
import { mcp as mcpTable, mcpOauthState, workspace } from "../db/schema.ts";
import { mcpOauthCallbackSchema } from "@platypus/schemas";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";
import {
  DatabaseOAuthClientProvider,
  oauthFetchFn,
  buildOAuthCallbackUrl,
} from "../services/mcp-oauth-provider.ts";

const mcpOauthCallback = new Hono<{ Variables: Variables }>();

/** Exchange OAuth authorization code for tokens (state-based lookup) */
mcpOauthCallback.post(
  "/",
  requireAuth,
  validate("json", mcpOauthCallbackSchema),
  async (c) => {
    const { code, state } = c.req.valid("json");

    // Look up the MCP via the state parameter
    const [stateRecord] = await db
      .select()
      .from(mcpOauthState)
      .where(eq(mcpOauthState.id, state))
      .limit(1);

    if (!stateRecord) {
      return c.json({ error: "Invalid or expired OAuth state" }, 400);
    }

    // Check expiry
    if (stateRecord.expiresAt < new Date()) {
      await db.delete(mcpOauthState).where(eq(mcpOauthState.id, state));
      return c.json({ error: "OAuth state has expired" }, 400);
    }

    const [mcpRecord] = await db
      .select()
      .from(mcpTable)
      .where(eq(mcpTable.id, stateRecord.mcpId))
      .limit(1);

    if (!mcpRecord) {
      return c.json({ error: "MCP not found" }, 404);
    }

    if (!mcpRecord.url) {
      return c.json({ error: "MCP URL is not configured" }, 400);
    }

    // Resolve the orgId for the redirect URL. An org-scoped (Shared) MCP
    // carries its orgId directly; a workspace-scoped MCP gets it from its
    // workspace.
    let redirectOrgId = mcpRecord.organizationId;
    if (!redirectOrgId && mcpRecord.workspaceId) {
      const [wsRecord] = await db
        .select()
        .from(workspace)
        .where(eq(workspace.id, mcpRecord.workspaceId))
        .limit(1);

      if (!wsRecord) {
        return c.json({ error: "Workspace not found" }, 404);
      }
      redirectOrgId = wsRecord.organizationId;
    }

    try {
      const callbackUrl = buildOAuthCallbackUrl();
      const provider = new DatabaseOAuthClientProvider(mcpRecord, callbackUrl);
      provider.setStateForLookup(state);

      const result = await mcpAuth(provider, {
        serverUrl: mcpRecord.url,
        authorizationCode: code,
        callbackState: state,
        fetchFn: oauthFetchFn,
      });

      // Clean up the state record
      await db.delete(mcpOauthState).where(eq(mcpOauthState.id, state));

      if (result === "AUTHORIZED") {
        return c.json({
          orgId: redirectOrgId,
          workspaceId: mcpRecord.workspaceId,
          mcpId: mcpRecord.id,
        });
      }

      return c.json({ error: "Unexpected OAuth result" }, 500);
    } catch (error) {
      logger.error({ error }, "OAuth callback error");
      const errorMessage =
        error instanceof Error ? error.message : "OAuth token exchange failed";
      return c.json({ error: errorMessage }, 500);
    }
  },
);

export { mcpOauthCallback };
