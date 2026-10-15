import {
  auth as mcpAuth,
  type OAuthAuthorizationServerInformation,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import { frontendBaseUrl } from "../base-urls.ts";
import { mcp as mcpTable, mcpOauthState } from "../db/schema.ts";

export type McpRecord = typeof mcpTable.$inferSelect;

/** Fields to null-out when clearing OAuth tokens. */
export const OAUTH_TOKEN_CLEAR_FIELDS = {
  oauthAccessToken: null,
  oauthRefreshToken: null,
  oauthTokenExpiresAt: null,
  oauthScope: null,
  oauthAuthorizationServer: null,
} as const;

/** Fields to reset when dropping the OAuth client registration. */
export const OAUTH_CLIENT_CLEAR_FIELDS = {
  oauthClientId: null,
  oauthClientSecret: null,
  oauthClientDynamicallyRegistered: false,
} as const;

/** Cached callback URL (depends only on env vars, so computed once). */
let _cachedCallbackUrl: string | undefined;

/** Build the stable OAuth callback URL used across all OAuth flows. */
export const buildOAuthCallbackUrl = () => {
  if (!_cachedCallbackUrl) {
    const frontendUrl = frontendBaseUrl().replace(/\/+$/, "");
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
export const oauthFetchFn: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
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

  /** This MCP's OAuth columns, re-read so a refresh sees the latest tokens. */
  private async oauthRow() {
    const records = await db
      .select({
        oauthAccessToken: mcpTable.oauthAccessToken,
        oauthRefreshToken: mcpTable.oauthRefreshToken,
        oauthTokenExpiresAt: mcpTable.oauthTokenExpiresAt,
        oauthScope: mcpTable.oauthScope,
        oauthClientId: mcpTable.oauthClientId,
        oauthClientSecret: mcpTable.oauthClientSecret,
        oauthClientDynamicallyRegistered:
          mcpTable.oauthClientDynamicallyRegistered,
        oauthAuthorizationServer: mcpTable.oauthAuthorizationServer,
      })
      .from(mcpTable)
      .where(eq(mcpTable.id, this.mcpRecord.id))
      .limit(1);
    return records[0];
  }

  async tokens() {
    const record = await this.oauthRow();
    this._refreshTokenRead = record?.oauthRefreshToken ?? undefined;
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

  async saveTokens(tokens: OAuthTokens) {
    await db
      .update(mcpTable)
      .set({
        oauthAccessToken: tokens.access_token,
        oauthRefreshToken: tokens.refresh_token ?? null,
        oauthTokenExpiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000)
          : null,
        oauthScope: tokens.scope ?? null,
        // The library tags every token response with the server that issued
        // it; that is the record a later refresh is checked against.
        ...(tokens.authorization_server &&
          tokens.token_endpoint && {
            oauthAuthorizationServer: {
              issuer: tokens.issuer,
              authorizationServerUrl: tokens.authorization_server,
              tokenEndpoint: tokens.token_endpoint,
            },
          }),
        updatedAt: new Date(),
      })
      .where(
        // A refresh writes only over the sign-in it refreshed: a sign-out or
        // Client ID change since must not get the old client's tokens back.
        // A code exchange read no tokens and starts a new sign-in.
        this._refreshTokenRead
          ? this.sameSignIn(this._refreshTokenRead)
          : eq(mcpTable.id, this.mcpRecord.id),
      );
  }

  /** This MCP, while it still holds the sign-in `refreshToken` belongs to. */
  private sameSignIn(refreshToken: string) {
    return and(
      eq(mcpTable.id, this.mcpRecord.id),
      eq(mcpTable.oauthRefreshToken, refreshToken),
    );
  }

  async clientInformation() {
    return toClientInformation(await this.oauthRow());
  }

  // Only called after dynamic client registration: an Operator-entered client
  // is written by mcp-write, never by the library.
  async saveClientInformation(clientInfo: {
    client_id: string;
    client_secret?: string;
  }) {
    await db
      .update(mcpTable)
      .set({
        oauthClientId: clientInfo.client_id,
        oauthClientSecret: clientInfo.client_secret ?? null,
        oauthClientDynamicallyRegistered: true,
        updatedAt: new Date(),
      })
      .where(eq(mcpTable.id, this.mcpRecord.id));
  }

  async isClientInformationDynamicallyRegistered() {
    return (await this.oauthRow())?.oauthClientDynamicallyRegistered ?? false;
  }

  // The library only invalidates after a refresh or code exchange failed. Only
  // the refresh token this provider read and failed with is dropped: a
  // concurrent request may already have rotated it, and a callback's failed
  // code exchange (read no tokens) leaves the MCP's sign-in alone.
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier") {
    if (scope === "verifier" || !this._refreshTokenRead) return;
    await db
      .update(mcpTable)
      .set({
        ...(scope !== "client" && OAUTH_TOKEN_CLEAR_FIELDS),
        ...(scope !== "tokens" && OAUTH_CLIENT_CLEAR_FIELDS),
        updatedAt: new Date(),
      })
      .where(this.sameSignIn(this._refreshTokenRead));
  }

  // @ai-sdk/mcp refuses the code exchange and token refresh without a record
  // of the authorization server they belong to.
  async authorizationServerInformation() {
    // A callback is checked against the server its own sign-in started with.
    if (this._stateForLookup) {
      const states = await db
        .select({ info: mcpOauthState.authorizationServer })
        .from(mcpOauthState)
        .where(eq(mcpOauthState.id, this._stateForLookup))
        .limit(1);
      return states[0]?.info ?? undefined;
    }
    const record = await this.oauthRow();
    if (record?.oauthAuthorizationServer)
      return record.oauthAuthorizationServer;
    if (record?.oauthRefreshToken)
      return this.adoptAuthorizationServer(record, record.oauthRefreshToken);
    return undefined;
  }

  async saveAuthorizationServerInformation(
    info: OAuthAuthorizationServerInformation,
  ) {
    // Bound to this sign-in, not to the MCP: saveTokens() records it on the MCP
    // once the code exchange succeeds.
    await db
      .update(mcpOauthState)
      .set({ authorizationServer: info })
      .where(eq(mcpOauthState.id, this.state()));
  }

  validateAuthorizationServerURL(_serverUrl: string | URL, url: string | URL) {
    this._authorizationServerUrl = new URL(url).href;
  }

  /**
   * Rows authorized before @ai-sdk/mcp 2.0.57 hold a refresh token but no
   * record, and the library will not refresh without one. Adopt what discovery
   * reports now (the trust those tokens already had) for the authorization
   * server this auth() call already discovered and vetted, read by the
   * library's own metadata discovery through a throwaway sign-in started at
   * that server, and kept only when it agrees with that server.
   */
  // ponytail: one-off backfill; delete once no OAuth MCP with a refresh token has a NULL oauth_authorization_server.
  private async adoptAuthorizationServer(
    record: OAuthClientColumns,
    refreshToken: string,
  ) {
    const client = toClientInformation(record);
    if (!client || !this._authorizationServerUrl) return undefined;
    let adopted: OAuthAuthorizationServerInformation | undefined;
    // A failure is thrown, not answered with undefined: undefined makes the
    // library drop the tokens, and a network blip must not sign the MCP out.
    await mcpAuth(
      {
        redirectUrl: this.callbackUrl,
        clientMetadata: this.clientMetadata,
        clientInformation: () => client,
        tokens: () => undefined,
        saveTokens: () => {},
        codeVerifier: () => "",
        saveCodeVerifier: () => {},
        redirectToAuthorization: () => {},
        // The resource belongs to the MCP, not to this throwaway sign-in.
        validateResourceURL: () => Promise.resolve(undefined),
        saveAuthorizationServerInformation: (info) => {
          adopted = info;
        },
      },
      { serverUrl: this._authorizationServerUrl, fetchFn: oauthFetchFn },
    );
    if (
      !adopted ||
      adopted.authorizationServerUrl !== this._authorizationServerUrl
    ) {
      return undefined;
    }
    // Only onto the sign-in it was discovered for: one that finished meanwhile
    // already holds its own record, and the refresh token in hand is spent.
    // Refreshing with it anyway would trip reuse detection and revoke the new
    // sign-in too.
    const updated = await db
      .update(mcpTable)
      .set({ oauthAuthorizationServer: adopted })
      .where(this.sameSignIn(refreshToken))
      .returning({ id: mcpTable.id });
    return updated.length ? adopted : undefined;
  }

  redirectToAuthorization(authorizationUrl: URL) {
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

  state(): string {
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

  storedState(): string | undefined {
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
  private _authorizationServerUrl?: string;
  private _refreshTokenRead?: string;
}

type OAuthClientColumns = Pick<
  McpRecord,
  "oauthClientId" | "oauthClientSecret" | "oauthAuthorizationServer"
>;

const toClientInformation = (record: OAuthClientColumns | undefined) => {
  if (!record?.oauthClientId) return undefined;

  const server = record.oauthAuthorizationServer;
  return {
    client_id: record.oauthClientId,
    ...(record.oauthClientSecret && {
      client_secret: record.oauthClientSecret,
    }),
    // Lets the library check, before reusing this client, that discovery
    // still points at the server it was used with.
    ...(server && {
      issuer: server.issuer,
      authorization_server: server.authorizationServerUrl,
      token_endpoint: server.tokenEndpoint,
    }),
  };
};
