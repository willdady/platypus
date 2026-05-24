import type { OAuthClientProvider } from "@ai-sdk/mcp";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import { mcp as mcpTable, mcpOauthState } from "../db/schema.ts";

export type McpRecord = typeof mcpTable.$inferSelect;

/** Cached callback URL (depends only on env vars, so computed once). */
let _cachedCallbackUrl: string | undefined;

/** Build the stable OAuth callback URL used across all OAuth flows. */
export const buildOAuthCallbackUrl = () => {
  if (!_cachedCallbackUrl) {
    const frontendUrl = (
      process.env.FRONTEND_URL || "http://localhost:3001"
    ).replace(/\/+$/, "");
    _cachedCallbackUrl = `${frontendUrl}/oauth/mcp/callback`;
  }
  return _cachedCallbackUrl;
};

/**
 * Build a transport config object for an MCP client, handling
 * OAuth / Bearer / None auth types.
 */
export const buildMcpTransportConfig = (mcp: McpRecord) => {
  const config: {
    type: "http";
    url: string;
    headers?: Record<string, string>;
    authProvider?: DatabaseOAuthClientProvider;
  } = {
    type: "http",
    url: mcp.url!,
  };

  const customHeaders = mcp.headers ?? {};

  if (mcp.authType === "OAuth" && mcp.oauthAccessToken) {
    const callbackUrl = buildOAuthCallbackUrl();
    config.authProvider = new DatabaseOAuthClientProvider(mcp, callbackUrl);
    if (Object.keys(customHeaders).length > 0) {
      config.headers = customHeaders;
    }
  } else if (mcp.authType === "Bearer") {
    config.headers = {
      ...customHeaders,
      Authorization: `Bearer ${mcp.bearerToken}`,
    };
  } else if (Object.keys(customHeaders).length > 0) {
    config.headers = customHeaders;
  }

  return config;
};

/**
 * Wraps the global fetch to work around a bug in @ai-sdk/mcp where
 * `parseErrorResponse` fails the `instanceof Response` check in Node.js,
 * producing an unhelpful "[object Response]" error message. This wrapper
 * returns a fresh Response constructed from the original, ensuring the
 * `instanceof Response` check succeeds in the library's error handler.
 */
/**
 * Optional comma-separated list of `from=to` URL prefix substitutions applied
 * to fetches issued by the MCP OAuth flow. Lets the backend reach a server
 * that advertises a browser-only URL (e.g. `http://localhost:8765`) via a
 * different network path (e.g. `http://workspace-mcp:8000`) without changing
 * what the server advertises to the browser.
 *
 * Example:
 *   MCP_OAUTH_HOST_REWRITES="http://localhost:8765=http://workspace-mcp:8000"
 */
const parseHostRewrites = (): Array<[string, string]> => {
  const raw = process.env.MCP_OAUTH_HOST_REWRITES;
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [from, to] = entry.split("=").map((s) => s.trim());
      if (!from || !to) return undefined;
      return [from, to] as [string, string];
    })
    .filter((pair): pair is [string, string] => pair !== undefined);
};

const HOST_REWRITES = parseHostRewrites();

const rewriteUrl = (url: string): string => {
  for (const [from, to] of HOST_REWRITES) {
    if (url.startsWith(from)) return to + url.slice(from.length);
  }
  return url;
};

export const oauthFetchFn: typeof fetch = async (input, init) => {
  const rewrittenInput =
    typeof input === "string"
      ? rewriteUrl(input)
      : input instanceof URL
        ? new URL(rewriteUrl(input.href))
        : input;
  const response = await fetch(rewrittenInput, init);
  if (!response.ok) {
    // Work around @ai-sdk/mcp bug where `parseErrorResponse` fails the
    // `instanceof Response` check in Node.js (different Response realms).
    // Reconstruct using the global Response constructor.
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return response;
};

/**
 * Database-backed OAuthClientProvider for MCP OAuth flows.
 * Used by both the authorize/callback endpoints and the HTTP transport during chat.
 */
export class DatabaseOAuthClientProvider implements OAuthClientProvider {
  private mcpRecord: McpRecord;
  private callbackUrl: string;
  private pendingAuthUrl: URL | undefined;

  constructor(mcpRecord: McpRecord, callbackUrl: string) {
    this.mcpRecord = mcpRecord;
    this.callbackUrl = callbackUrl;
  }

  get redirectUrl(): string | URL {
    return this.callbackUrl;
  }

  /**
   * Trust the resource URL advertised by the MCP server even when its origin
   * differs from the URL we use to reach it. This lets the backend talk to an
   * MCP server through a different network path (docker hostname, host gateway,
   * SSH tunnel) than the browser-facing URL the server advertises during OAuth
   * discovery. Without this override, `@ai-sdk/mcp` rejects the mismatch as
   * `Protected resource ... does not match expected ... (or origin)`.
   */
  async validateResourceURL(
    _serverUrl: URL,
    resource?: string,
  ): Promise<URL | undefined> {
    return resource ? new URL(resource) : undefined;
  }

  /**
   * Force the `client_secret_post` token-endpoint auth method (client_id +
   * client_secret in the POST body). The default selection prefers
   * `client_secret_basic` when the server advertises it, but some MCP servers
   * (e.g. FastMCP-based ones) advertise Basic support without actually parsing
   * the `Authorization: Basic ...` header, returning a misleading
   * `invalid_client / Missing client_id` 401.
   */
  addClientAuthentication = async (
    headers: Headers,
    params: URLSearchParams,
  ): Promise<void> => {
    const records = await db
      .select({
        oauthClientId: mcpTable.oauthClientId,
        oauthClientSecret: mcpTable.oauthClientSecret,
      })
      .from(mcpTable)
      .where(eq(mcpTable.id, this.mcpRecord.id))
      .limit(1);
    const record = records[0];
    if (!record?.oauthClientId) return;
    params.set("client_id", record.oauthClientId);
    if (record.oauthClientSecret) {
      params.set("client_secret", record.oauthClientSecret);
    }
    // Make sure we do not also send a stale Basic header.
    headers.delete("Authorization");
  };

  get clientMetadata() {
    return {
      redirect_uris: [this.callbackUrl],
      client_name: "Platypus",
      token_endpoint_auth_method: "client_secret_post" as const,
      // Authorization servers require an explicit `scope` parameter (e.g. Google
      // returns 400 "Missing required parameter: scope" otherwise). The MCP
      // library forwards `clientMetadata.scope` into the authorize URL.
      ...(this.mcpRecord.oauthRequestedScope && {
        scope: this.mcpRecord.oauthRequestedScope,
      }),
    };
  }

  async tokens() {
    // Re-read from DB to get latest tokens (important for token refresh)
    const records = await db
      .select({
        oauthAccessToken: mcpTable.oauthAccessToken,
        oauthRefreshToken: mcpTable.oauthRefreshToken,
        oauthTokenExpiresAt: mcpTable.oauthTokenExpiresAt,
        oauthScope: mcpTable.oauthScope,
      })
      .from(mcpTable)
      .where(eq(mcpTable.id, this.mcpRecord.id))
      .limit(1);
    const record = records[0];
    if (!record?.oauthAccessToken) return undefined;

    return {
      access_token: record.oauthAccessToken,
      token_type: "bearer",
      ...(record.oauthRefreshToken && {
        refresh_token: record.oauthRefreshToken,
      }),
      ...(record.oauthTokenExpiresAt && {
        expires_in: Math.floor(
          (record.oauthTokenExpiresAt.getTime() - Date.now()) / 1000,
        ),
      }),
      ...(record.oauthScope && { scope: record.oauthScope }),
    };
  }

  async saveTokens(tokens: {
    access_token: string;
    token_type: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  }) {
    await db
      .update(mcpTable)
      .set({
        oauthAccessToken: tokens.access_token,
        oauthRefreshToken: tokens.refresh_token ?? null,
        oauthTokenExpiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000)
          : null,
        oauthScope: tokens.scope ?? null,
        updatedAt: new Date(),
      })
      .where(eq(mcpTable.id, this.mcpRecord.id));
  }

  async clientInformation() {
    const records = await db
      .select({
        oauthClientId: mcpTable.oauthClientId,
        oauthClientSecret: mcpTable.oauthClientSecret,
      })
      .from(mcpTable)
      .where(eq(mcpTable.id, this.mcpRecord.id))
      .limit(1);
    const record = records[0];
    if (!record?.oauthClientId) return undefined;

    return {
      client_id: record.oauthClientId,
      ...(record.oauthClientSecret && {
        client_secret: record.oauthClientSecret,
      }),
    };
  }

  async saveClientInformation(clientInfo: {
    client_id: string;
    client_secret?: string;
  }) {
    await db
      .update(mcpTable)
      .set({
        oauthClientId: clientInfo.client_id,
        oauthClientSecret: clientInfo.client_secret ?? null,
        updatedAt: new Date(),
      })
      .where(eq(mcpTable.id, this.mcpRecord.id));
  }

  async redirectToAuthorization(authorizationUrl: URL) {
    // Google requires access_type=offline to return a refresh token.
    // prompt=consent forces re-consent even if the user previously authorized,
    // which is required when requesting offline access for the first time.
    if (
      authorizationUrl.hostname.endsWith(".google.com") ||
      authorizationUrl.hostname === "google.com"
    ) {
      authorizationUrl.searchParams.set("access_type", "offline");
      authorizationUrl.searchParams.set("prompt", "consent");
    }
    this.pendingAuthUrl = authorizationUrl;
  }

  getPendingAuthUrl(): URL | undefined {
    return this.pendingAuthUrl;
  }

  async saveCodeVerifier(codeVerifier: string) {
    this._pendingCodeVerifier = codeVerifier;
    // The library calls saveState() before saveCodeVerifier(), so if the
    // state record already exists we need to update it with the real verifier.
    if (this._generatedState) {
      await db
        .update(mcpOauthState)
        .set({ codeVerifier })
        .where(eq(mcpOauthState.id, this._generatedState));
    }
  }

  async codeVerifier(): Promise<string> {
    // Read from mcpOauthState table using the stored state
    if (this._stateForLookup) {
      const records = await db
        .select()
        .from(mcpOauthState)
        .where(eq(mcpOauthState.id, this._stateForLookup))
        .limit(1);
      if (records[0]) {
        return records[0].codeVerifier;
      }
    }
    throw new Error("No code verifier found");
  }

  async state(): Promise<string> {
    if (!this._generatedState) this._generatedState = nanoid();
    return this._generatedState;
  }

  async saveState(state: string) {
    this._generatedState = state;
    // Create the mcpOauthState record with the code verifier
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min TTL
    await db.insert(mcpOauthState).values({
      id: state,
      mcpId: this.mcpRecord.id,
      codeVerifier: this._pendingCodeVerifier || "",
      redirectUri: this.callbackUrl,
      expiresAt,
    });
  }

  async storedState(): Promise<string | undefined> {
    return this._stateForLookup;
  }

  /**
   * Sets the state value used for looking up the code verifier during callback.
   * This is called before invoking auth() for the callback flow.
   */
  setStateForLookup(state: string) {
    this._stateForLookup = state;
  }

  private _pendingCodeVerifier?: string;
  private _generatedState?: string;
  private _stateForLookup?: string;
}
