import {
  experimental_createMCPClient as createMCPClient,
  auth as mcpAuth,
} from "@ai-sdk/mcp";
import { isDeepStrictEqual } from "node:util";
import { eq, type SQL } from "drizzle-orm";
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
import { MCP_OPEN_TIMEOUT_MS } from "../tools/tool-session.ts";
import { withDeadline } from "../utils/abort-race.ts";

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
 * Whether a test connected the way a turn would — with the stored row's own
 * connection, not unsaved edits to it — so its success says something about
 * the stored MCP.
 */
const testedStoredConnection = (
  data: McpTestInput,
  stored: McpRecord,
): boolean =>
  data.authType === "OAuth" ||
  (data.url === stored.url &&
    data.authType === stored.authType &&
    isDeepStrictEqual(data.headers ?? null, stored.headers ?? null) &&
    (data.authType !== "Bearer" || data.bearerToken === stored.bearerToken));

/**
 * Probes an MCP server and reports its (namespaced) tool names — the `/test`
 * route's whole job. `storedMcp` is the row a caller already resolved for
 * `data.mcpId` (`null` when there is none, or no such row is visible). Only an
 * OAuth test connects with its stored credentials; a Bearer/None test uses
 * what it was sent. A success with the stored connection clears the row's
 * recorded fetch failure, so the next turn tries the server again (ADR-0031).
 *
 * Bounded by `MCP_OPEN_TIMEOUT_MS`, like a turn's own fetch: a server that
 * takes the connection and never answers is reported, not waited on.
 */
export const probeMcpConnection = async (
  data: McpTestInput,
  storedMcp: McpRecord | null,
): Promise<McpProbeResult> => {
  let opening: ReturnType<typeof createMCPClient> | undefined;

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
      opening = createMCPClient({
        transport: buildMcpTransportConfig(storedMcp),
      });
    } else {
      opening = createMCPClient({
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

    const connecting = opening;
    const { client, rawToolNames } = await withDeadline(async () => {
      const connected = await connecting;
      return {
        client: connected,
        rawToolNames: Object.keys(await connected.tools()),
      };
    }, MCP_OPEN_TIMEOUT_MS);
    await client.close();

    if (
      storedMcp?.lastFetchFailedAt &&
      testedStoredConnection(data, storedMcp)
    ) {
      try {
        await db
          .update(mcpTable)
          .set({ lastFetchFailedAt: null })
          .where(eq(mcpTable.id, storedMcp.id));
      } catch (error) {
        logger.warn(
          { error, mcpId: storedMcp.id },
          "Failed to clear an MCP's last fetch failure",
        );
      }
    }

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
    // Closed now, or when a connect that outran the deadline lands.
    void opening?.then(
      (client) =>
        client.close().catch((closeError: unknown) => {
          logger.error({ error: closeError }, "Error closing MCP client");
        }),
      () => {},
    );

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
