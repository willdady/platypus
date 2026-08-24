import {
  experimental_createMCPClient as createMCPClient,
  auth as mcpAuth,
} from "@ai-sdk/mcp";
import type { SQL } from "drizzle-orm";
import type { mcpTestSchema } from "@platypus/schemas";
import type { z } from "zod";
import { db } from "../index.ts";
import { mcp as mcpTable } from "../db/schema.ts";
import {
  DatabaseOAuthClientProvider,
  oauthFetchFn,
  buildOAuthCallbackUrl,
  buildMcpTransportConfig,
  type McpRecord,
} from "./mcp-oauth-provider.ts";
import { resolveMcpTestToolNames } from "./mcp-test-tools.ts";
import { logger } from "../logger.ts";

/**
 * The MCP-connection choreography — probe / authorize / revoke — that both
 * `routes/mcp.ts` (Workspace surface) and `routes/org-mcp.ts` (Organization
 * surface) delegate to, rather than each re-implementing client construction,
 * `Bearer` header assembly, close-on-error handling, and the OAuth
 * redirect/alreadyAuthorized branch.
 *
 * Every function here takes an already-resolved row (or `null`/`undefined`
 * when there is none), never a scope + id — resolving a row is the Scoped-
 * resource authority's job (`services/scoped-resource.ts`), not this module's.
 * That keeps this module ignorant of *how* a row became visible, so the same
 * probe/authorize/revoke choreography serves both surfaces even though they
 * resolve rows differently (`resolveScoped`/`requireWorkspaceMutable` on the
 * Workspace surface vs `resolveOrgScoped`/`requireOrgScoped` on the
 * Organization surface).
 *
 * **Decided Shared-MCP semantics on the Workspace surface** (ADR-0006,
 * ADR-0007): an attached Shared MCP is a single source of truth owned by the
 * Organization, but *reading through* it to probe a live server changes
 * nothing about who owns its credentials, so:
 * - `probeMcpConnection` is read-only and takes any row visible to the caller
 *   (workspace-scoped or an attached Shared MCP) — a route resolves it with
 *   `resolveScoped`/`resolveOrgScoped`, which admit both.
 * - `authorizeMcpOAuth` and `clearOAuthTokens` mutate org-owned OAuth
 *   credentials, so a route resolves the row with `requireWorkspaceMutable`
 *   first: `NotFoundError` (404) when the row is not visible at all, then
 *   `LockedError` (403) when it is a Shared row — the same refusal a
 *   Workspace Owner already gets from `PUT`/`DELETE` on this file, rather than
 *   the bare 404 that used to deny the row's existence.
 */

/** Fields to null-out when clearing OAuth tokens. */
export const OAUTH_TOKEN_CLEAR_FIELDS = {
  oauthAccessToken: null,
  oauthRefreshToken: null,
  oauthTokenExpiresAt: null,
  oauthScope: null,
} as const;

type Database = typeof db;

export type McpTestInput = z.infer<typeof mcpTestSchema>;

export type McpProbeResult =
  | { success: true; toolNames: string[]; invalidToolNames: string[] }
  | { success: false; error: string; status: 400 | 404 };

/**
 * Probes an MCP server and reports its (namespaced) tool names — the `/test`
 * route's whole job. `storedMcp` is the row a caller already resolved for
 * `data.mcpId` when `data.authType === "OAuth"` (`null` when no such row is
 * visible); ignored otherwise, since a Bearer/None test never reads stored
 * credentials.
 */
export const probeMcpConnection = async (
  data: McpTestInput,
  storedMcp: McpRecord | null,
): Promise<McpProbeResult> => {
  let mcpClient: Awaited<ReturnType<typeof createMCPClient>> | undefined;

  try {
    if (data.authType === "OAuth" && data.mcpId) {
      if (!storedMcp) {
        return { success: false, error: "MCP not found", status: 404 };
      }
      if (!storedMcp.oauthAccessToken) {
        return {
          success: false,
          error: "MCP not yet authorized. Click Authorize first.",
          status: 400,
        };
      }
      mcpClient = await createMCPClient({
        transport: buildMcpTransportConfig(storedMcp),
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
    const rawToolNames = Object.keys(mcpTools);
    await mcpClient.close();

    // Namespaced under the MCP's slug (issue #467), so this reports exactly
    // what a Chat turn will see.
    const { toolNames, invalidToolNames } = await resolveMcpTestToolNames(
      rawToolNames,
      data.name,
      data.mcpId,
      () => Promise.resolve(storedMcp?.name),
    );

    return { success: true, toolNames, invalidToolNames };
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

    return { success: false, error: errorMessage, status: 400 };
  }
};

export type McpOAuthAuthorizeResult =
  | { kind: "redirect"; authorizationUrl: string }
  | { kind: "alreadyAuthorized" }
  | { kind: "error"; message: string; status: 400 | 500 };

/**
 * Clears the four OAuth token columns for the row(s) matching `where` — the
 * single spelling of the `force=true` reauthorize choreography and the
 * `/oauth/revoke` handler, so both surfaces share the null-patch and neither
 * hand-rolls it again. Returns the updated rows so a caller that needs the
 * refreshed value (the `force` branch of {@link authorizeMcpOAuth}) does not
 * re-read.
 */
export const clearOAuthTokens = (
  database: Database,
  where: SQL,
): Promise<McpRecord[]> =>
  database
    .update(mcpTable)
    .set({ ...OAUTH_TOKEN_CLEAR_FIELDS, updatedAt: new Date() })
    .where(where)
    .returning();

/**
 * Runs the OAuth authorize choreography for an already-resolved, visible MCP
 * row. `force` clears stored tokens first via `clearTokensWhere` so `mcpAuth`
 * always returns `REDIRECT`, letting the UI offer a single-click
 * "Reauthorize" even when Platypus still holds a valid refresh token (the SDK
 * would otherwise silently refresh and report `AUTHORIZED`, which the
 * frontend currently shows as a failure because no authorizationUrl is
 * returned). The DCR/static `oauthClientId`/`oauthClientSecret` are preserved
 * so the same OAuth client is reused.
 */
export const authorizeMcpOAuth = async (
  database: Database,
  mcpRecord: McpRecord,
  opts: { force: boolean; clearTokensWhere: SQL },
): Promise<McpOAuthAuthorizeResult> => {
  if (mcpRecord.authType !== "OAuth") {
    return {
      kind: "error",
      message: "MCP auth type is not OAuth",
      status: 400,
    };
  }
  if (!mcpRecord.url) {
    return { kind: "error", message: "MCP URL is not configured", status: 400 };
  }
  const serverUrl = mcpRecord.url;

  let record = mcpRecord;
  if (opts.force) {
    await clearOAuthTokens(database, opts.clearTokensWhere);
    record = { ...record, ...OAUTH_TOKEN_CLEAR_FIELDS };
  }

  try {
    const callbackUrl = buildOAuthCallbackUrl();
    const provider = new DatabaseOAuthClientProvider(record, callbackUrl);

    const result = await mcpAuth(provider, {
      serverUrl,
      fetchFn: oauthFetchFn,
    });

    if (result === "REDIRECT") {
      const authUrl = provider.getPendingAuthUrl();
      if (!authUrl) {
        return {
          kind: "error",
          message: "Failed to generate authorization URL",
          status: 500,
        };
      }
      return { kind: "redirect", authorizationUrl: authUrl.toString() };
    }

    // Already authorized — refresh token still valid, SDK rotated silently.
    // Reported as success so the frontend can treat it as a no-op rather
    // than an error.
    return { kind: "alreadyAuthorized" };
  } catch (error) {
    logger.error({ error }, "OAuth authorize error");
    const message =
      error instanceof Error ? error.message : "OAuth authorization failed";
    return { kind: "error", message, status: 500 };
  }
};
