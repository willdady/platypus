import {
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

export const OAUTH_TOKEN_CLEAR_FIELDS = {
  oauthAccessToken: null,
  oauthRefreshToken: null,
  oauthTokenExpiresAt: null,
  oauthScope: null,
  oauthAuthorizationServer: null,
} as const;

export const OAUTH_CLIENT_CLEAR_FIELDS = {
  oauthClientId: null,
  oauthClientSecret: null,
  oauthClientDynamicallyRegistered: false,
} as const;

let _cachedCallbackUrl: string | undefined;

export const buildOAuthCallbackUrl = () => {
  if (!_cachedCallbackUrl) {
    const frontendUrl = frontendBaseUrl().replace(/\/+$/, "");
    _cachedCallbackUrl = `${frontendUrl}/oauth/mcp/callback`;
  }
  return _cachedCallbackUrl;
};

export const buildMcpTransportConfig = (mcp: McpRecord) => {
  if (!mcp.url) throw new Error(`MCP server '${mcp.name}' has no URL`);
  const config: {
    type: "http";
    url: string;
    headers?: Record<string, string>;
    authProvider?: DatabaseOAuthClientProvider;
  } = {
    type: "http",
    url: mcp.url,
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

// why: @ai-sdk/mcp parseErrorResponse fails instanceof Response on Node fetch; drop when fixed
export const oauthFetchFn: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return response;
};

export class DatabaseOAuthClientProvider implements OAuthClientProvider {
  private mcpRecord: McpRecord;
  private callbackUrl: string;
  private userId: string | undefined;
  private pendingAuthUrl: URL | undefined;

  constructor(mcpRecord: McpRecord, callbackUrl: string, userId?: string) {
    this.mcpRecord = mcpRecord;
    this.callbackUrl = callbackUrl;
    this.userId = userId;
  }

  get redirectUrl(): string | URL {
    return this.callbackUrl;
  }

  get clientMetadata() {
    return {
      redirect_uris: [this.callbackUrl],
      client_name: "Platypus",
      token_endpoint_auth_method: "client_secret_post" as const,
      ...(this.mcpRecord.oauthRequestedScope && {
        scope: this.mcpRecord.oauthRequestedScope,
      }),
    };
  }

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
        this._refreshTokenRead
          ? this.sameSignIn(this._refreshTokenRead)
          : eq(mcpTable.id, this.mcpRecord.id),
      );
  }

  private sameSignIn(refreshToken: string) {
    return and(
      eq(mcpTable.id, this.mcpRecord.id),
      eq(mcpTable.oauthRefreshToken, refreshToken),
    );
  }

  async clientInformation() {
    return toClientInformation(await this.oauthRow());
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
        oauthClientDynamicallyRegistered: true,
        updatedAt: new Date(),
      })
      .where(eq(mcpTable.id, this.mcpRecord.id));
  }

  async isClientInformationDynamicallyRegistered() {
    return (await this.oauthRow())?.oauthClientDynamicallyRegistered ?? false;
  }

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

  async authorizationServerInformation() {
    if (this._stateForLookup) {
      const states = await db
        .select({ info: mcpOauthState.authorizationServer })
        .from(mcpOauthState)
        .where(eq(mcpOauthState.id, this._stateForLookup))
        .limit(1);
      return states[0]?.info ?? undefined;
    }
    return (await this.oauthRow())?.oauthAuthorizationServer ?? undefined;
  }

  async saveAuthorizationServerInformation(
    info: OAuthAuthorizationServerInformation,
  ) {
    await db
      .update(mcpOauthState)
      .set({ authorizationServer: info })
      .where(eq(mcpOauthState.id, this.state()));
  }

  redirectToAuthorization(authorizationUrl: URL) {
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
    if (this._generatedState) {
      await db
        .update(mcpOauthState)
        .set({ codeVerifier })
        .where(eq(mcpOauthState.id, this._generatedState));
    }
  }

  async codeVerifier(): Promise<string> {
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
    this._generatedState ??= nanoid();
    return this._generatedState;
  }

  async saveState(state: string) {
    this._generatedState = state;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await db.insert(mcpOauthState).values({
      id: state,
      mcpId: this.mcpRecord.id,
      userId: this.userId ?? null,
      codeVerifier: this._pendingCodeVerifier ?? "",
      redirectUri: this.callbackUrl,
      expiresAt,
    });
  }

  storedState(): string | undefined {
    return this._stateForLookup;
  }

  setStateForLookup(state: string) {
    this._stateForLookup = state;
  }

  private _pendingCodeVerifier?: string;
  private _generatedState?: string;
  private _stateForLookup?: string;
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
    ...(server && {
      issuer: server.issuer,
      authorization_server: server.authorizationServerUrl,
      token_endpoint: server.tokenEndpoint,
    }),
  };
};
