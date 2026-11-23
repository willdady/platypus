import { auth as mcpAuth } from "@ai-sdk/mcp";
import { isDeepStrictEqual } from "node:util";
import { and, eq, type SQL } from "drizzle-orm";
import type { mcpStoredTestSchema } from "@platypus/schemas";
import type { z } from "zod";
import { db } from "../index.ts";
import { mcp as mcpTable } from "../db/schema.ts";
import {
  DatabaseOAuthClientProvider,
  oauthFetchFn,
  buildOAuthCallbackUrl,
  buildMcpTransportConfig,
  OAUTH_CLIENT_CLEAR_FIELDS,
  OAUTH_TOKEN_CLEAR_FIELDS,
  type McpRecord,
} from "./mcp-oauth-provider.ts";
import {
  MCP_UNREACHABLE_MESSAGE,
  MCP_URL_BLOCKED_MESSAGE,
  McpEgressBlockedError,
  mcpUrlPermitted,
  openMcpClient,
} from "./mcp-client.ts";
import { resolveMcpTestToolNames } from "./mcp-test-tools.ts";
import { logger } from "../logger.ts";
import { TOOL_SET_RESOLVE_TIMEOUT_MS } from "../tools/index.ts";
import { withDeadline } from "../utils/abort-race.ts";

const probeErrorMessage = (error: unknown): string => {
  if (!isServerAnswer(error) || !(error instanceof Error)) {
    return MCP_UNREACHABLE_MESSAGE;
  }
  const { statusCode } = error as { statusCode?: unknown };
  return typeof statusCode === "number"
    ? `The MCP server responded with HTTP ${statusCode}.`
    : error.message;
};

const isServerAnswer = (error: unknown): boolean => {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (
      e instanceof McpEgressBlockedError ||
      e.message === "fetch failed" ||
      typeof (e as { code?: unknown }).code === "string"
    ) {
      return false;
    }
  }
  return (
    error instanceof Error &&
    (error.name === "MCPClientError" || error.name === "UnauthorizedError")
  );
};

type Database = typeof db;

export type McpTestInput = z.infer<typeof mcpStoredTestSchema>;

export type McpProbeResult =
  | { success: true; toolNames: string[]; invalidToolNames: string[] }
  | { success: false; error: string; status: 400 | 404 };

const testedStoredConnection = (
  data: McpTestInput,
  stored: McpRecord,
): boolean =>
  data.authType === "OAuth" ||
  (data.url === stored.url &&
    data.authType === stored.authType &&
    isDeepStrictEqual(data.headers ?? null, stored.headers ?? null) &&
    (data.authType !== "Bearer" || data.bearerToken === stored.bearerToken));

export const probeMcpConnection = async (
  data: McpTestInput,
  storedMcp: McpRecord | null,
): Promise<McpProbeResult> => {
  let opening: ReturnType<typeof openMcpClient> | undefined;

  try {
    if (data.authType === "OAuth") {
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
      opening = openMcpClient(buildMcpTransportConfig(storedMcp));
    } else {
      opening = openMcpClient({
        type: "http",
        url: data.url,
        headers: {
          ...data.headers,
          ...(data.authType === "Bearer"
            ? { Authorization: `Bearer ${data.bearerToken}` }
            : {}),
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
    }, TOOL_SET_RESOLVE_TIMEOUT_MS);
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

    const { toolNames, invalidToolNames } = resolveMcpTestToolNames(
      rawToolNames,
      data.name,
      storedMcp?.name,
    );

    return { success: true, toolNames, invalidToolNames };
  } catch (error) {
    void opening?.then(
      (client) =>
        client.close().catch((closeError: unknown) => {
          logger.error({ error: closeError }, "Error closing MCP client");
        }),
      () => {},
    );

    logger.error({ error }, "MCP test connection error");

    return { success: false, error: probeErrorMessage(error), status: 400 };
  }
};

export type McpOAuthAuthorizeResult =
  | { kind: "redirect"; authorizationUrl: string }
  | { kind: "alreadyAuthorized" }
  | { kind: "error"; message: string; status: 400 | 404 | 500 };

export const clearOAuthTokens = async (
  database: Database,
  where: SQL,
  { dropRegisteredClient }: { dropRegisteredClient: boolean },
): Promise<McpRecord[]> =>
  database.transaction(async (tx) => {
    if (dropRegisteredClient) {
      await tx
        .update(mcpTable)
        .set({ ...OAUTH_CLIENT_CLEAR_FIELDS, updatedAt: new Date() })
        .where(and(where, eq(mcpTable.oauthClientDynamicallyRegistered, true)));
    }
    return tx
      .update(mcpTable)
      .set({ ...OAUTH_TOKEN_CLEAR_FIELDS, updatedAt: new Date() })
      .where(where)
      .returning();
  });

export const authorizeMcpOAuth = async (
  database: Database,
  mcpRecord: McpRecord,
  opts: { force: boolean; clearTokensWhere: SQL; userId: string },
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
  if (!(await mcpUrlPermitted(serverUrl, mcpRecord.id))) {
    return { kind: "error", message: MCP_URL_BLOCKED_MESSAGE, status: 400 };
  }

  let record = mcpRecord;
  if (opts.force) {
    const [cleared] = await clearOAuthTokens(database, opts.clearTokensWhere, {
      dropRegisteredClient: true,
    });
    if (!cleared) {
      return { kind: "error", message: "MCP not found", status: 404 };
    }
    record = cleared;
  }

  try {
    const callbackUrl = buildOAuthCallbackUrl();
    const provider = new DatabaseOAuthClientProvider(
      record,
      callbackUrl,
      opts.userId,
    );

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

    return { kind: "alreadyAuthorized" };
  } catch (error) {
    logger.error({ error }, "OAuth authorize error");
    const message =
      error instanceof Error ? error.message : "OAuth authorization failed";
    return { kind: "error", message, status: 500 };
  }
};
