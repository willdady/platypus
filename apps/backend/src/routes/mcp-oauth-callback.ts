import { Hono } from "hono";
import { validate } from "../validate.ts";
import { auth as mcpAuth } from "@ai-sdk/mcp";
import { db } from "../index.ts";
import { mcp as mcpTable, mcpOauthState, workspace } from "../db/schema.ts";
import { mcpOauthCallbackSchema } from "@platypus/schemas";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import { userOf } from "../middleware/authorization.ts";
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

    // Only the user who started the sign-in may complete it. Otherwise any
    // signed-in user lured through the provider's consent screen would bind
    // their third-party account to the starter's MCP.
    if (stateRecord.userId !== userOf(c).id) {
      return c.json({ error: "OAuth state belongs to another user" }, 403);
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

      if (result === "AUTHORIZED") {
        return c.json({
          orgId: redirectOrgId,
          workspaceId: mcpRecord.workspaceId,
          mcpId: mcpRecord.id,
        });
      }

      return c.json({ error: "Unexpected OAuth result" }, 500);
    } catch (error) {
      // The library's message can name the authorization server's internals;
      // it goes to the log, not the browser.
      logger.error({ error }, "OAuth callback error");
      return c.json({ error: "OAuth token exchange failed" }, 500);
    } finally {
      // A state is single-use whatever the exchange's outcome. The provider
      // reads the row during the exchange, so it is removed after, not before.
      await db.delete(mcpOauthState).where(eq(mcpOauthState.id, state));
    }
  },
);

export { mcpOauthCallback };
