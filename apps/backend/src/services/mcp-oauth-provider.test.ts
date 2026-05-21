import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

describe("mcp-oauth-provider", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    delete process.env.FRONTEND_URL;
    // Reset the cached callback URL between tests
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.FRONTEND_URL;
  });

  describe("buildOAuthCallbackUrl", () => {
    it("should use default frontend URL when FRONTEND_URL is not set", async () => {
      const { buildOAuthCallbackUrl } = await import("./mcp-oauth-provider.ts");
      const url = buildOAuthCallbackUrl();
      expect(url).toBe("http://localhost:3001/oauth/mcp/callback");
    });

    it("should use FRONTEND_URL env var when set", async () => {
      process.env.FRONTEND_URL = "https://app.example.com";
      const { buildOAuthCallbackUrl } = await import("./mcp-oauth-provider.ts");
      const url = buildOAuthCallbackUrl();
      expect(url).toBe("https://app.example.com/oauth/mcp/callback");
    });

    it("should strip trailing slashes from FRONTEND_URL", async () => {
      process.env.FRONTEND_URL = "https://app.example.com///";
      const { buildOAuthCallbackUrl } = await import("./mcp-oauth-provider.ts");
      const url = buildOAuthCallbackUrl();
      expect(url).toBe("https://app.example.com/oauth/mcp/callback");
    });
  });

  describe("buildMcpTransportConfig", () => {
    it("should return basic config for None auth type", async () => {
      const { buildMcpTransportConfig } =
        await import("./mcp-oauth-provider.ts");
      const mcp = {
        id: "mcp-1",
        url: "http://mcp.example.com",
        authType: "None",
      } as any;

      const config = buildMcpTransportConfig(mcp);
      expect(config).toEqual({
        type: "http",
        url: "http://mcp.example.com",
      });
    });

    it("should add Bearer auth header for Bearer auth type", async () => {
      const { buildMcpTransportConfig } =
        await import("./mcp-oauth-provider.ts");
      const mcp = {
        id: "mcp-1",
        url: "http://mcp.example.com",
        authType: "Bearer",
        bearerToken: "my-secret-token",
      } as any;

      const config = buildMcpTransportConfig(mcp);
      expect(config).toEqual({
        type: "http",
        url: "http://mcp.example.com",
        headers: { Authorization: "Bearer my-secret-token" },
      });
    });

    it("should add authProvider for OAuth auth type with access token", async () => {
      const { buildMcpTransportConfig } =
        await import("./mcp-oauth-provider.ts");
      const mcp = {
        id: "mcp-1",
        url: "http://mcp.example.com",
        authType: "OAuth",
        oauthAccessToken: "access-token-123",
      } as any;

      const config = buildMcpTransportConfig(mcp);
      expect(config.type).toBe("http");
      expect(config.url).toBe("http://mcp.example.com");
      expect(config.authProvider).toBeDefined();
    });

    it("should pass custom headers with None auth type", async () => {
      const { buildMcpTransportConfig } =
        await import("./mcp-oauth-provider.ts");
      const mcp = {
        id: "mcp-1",
        url: "http://mcp.example.com",
        authType: "None",
        headers: { "X-Custom": "value", "X-Another": "test" },
      } as any;

      const config = buildMcpTransportConfig(mcp);
      expect(config).toEqual({
        type: "http",
        url: "http://mcp.example.com",
        headers: { "X-Custom": "value", "X-Another": "test" },
      });
    });

    it("should merge custom headers with Bearer auth, Authorization wins", async () => {
      const { buildMcpTransportConfig } =
        await import("./mcp-oauth-provider.ts");
      const mcp = {
        id: "mcp-1",
        url: "http://mcp.example.com",
        authType: "Bearer",
        bearerToken: "my-token",
        headers: {
          "X-Custom": "value",
          Authorization: "should-be-overridden",
        },
      } as any;

      const config = buildMcpTransportConfig(mcp);
      expect(config).toEqual({
        type: "http",
        url: "http://mcp.example.com",
        headers: {
          "X-Custom": "value",
          Authorization: "Bearer my-token",
        },
      });
    });

    it("should not set headers when headers is undefined", async () => {
      const { buildMcpTransportConfig } =
        await import("./mcp-oauth-provider.ts");
      const mcp = {
        id: "mcp-1",
        url: "http://mcp.example.com",
        authType: "None",
        headers: undefined,
      } as any;

      const config = buildMcpTransportConfig(mcp);
      expect(config).toEqual({
        type: "http",
        url: "http://mcp.example.com",
      });
      expect(config.headers).toBeUndefined();
    });

    it("should not set headers when headers is empty object", async () => {
      const { buildMcpTransportConfig } =
        await import("./mcp-oauth-provider.ts");
      const mcp = {
        id: "mcp-1",
        url: "http://mcp.example.com",
        authType: "None",
        headers: {},
      } as any;

      const config = buildMcpTransportConfig(mcp);
      expect(config).toEqual({
        type: "http",
        url: "http://mcp.example.com",
      });
      expect(config.headers).toBeUndefined();
    });

    it("should not add authProvider for OAuth without access token", async () => {
      const { buildMcpTransportConfig } =
        await import("./mcp-oauth-provider.ts");
      const mcp = {
        id: "mcp-1",
        url: "http://mcp.example.com",
        authType: "OAuth",
        oauthAccessToken: null,
      } as any;

      const config = buildMcpTransportConfig(mcp);
      expect(config.authProvider).toBeUndefined();
    });
  });

  describe("oauthFetchFn", () => {
    it("should return original response when ok", async () => {
      const { oauthFetchFn } = await import("./mcp-oauth-provider.ts");
      const mockResponse = new Response(JSON.stringify({ data: "test" }), {
        status: 200,
      });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      const result = await oauthFetchFn("http://example.com");
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);

      vi.unstubAllGlobals();
    });

    it("should reconstruct non-ok responses to fix instanceof check", async () => {
      const { oauthFetchFn } = await import("./mcp-oauth-provider.ts");
      const mockResponse = new Response("Bad Request", {
        status: 400,
        statusText: "Bad Request",
      });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      const result = await oauthFetchFn("http://example.com");
      expect(result.ok).toBe(false);
      expect(result.status).toBe(400);
      expect(result instanceof Response).toBe(true);
      expect(await result.text()).toBe("Bad Request");

      vi.unstubAllGlobals();
    });
  });

  describe("DatabaseOAuthClientProvider", () => {
    it("should return callbackUrl as redirectUrl", async () => {
      const { DatabaseOAuthClientProvider } =
        await import("./mcp-oauth-provider.ts");
      const provider = new DatabaseOAuthClientProvider(
        { id: "mcp-1" } as any,
        "http://localhost:3001/oauth/mcp/callback",
      );
      expect(provider.redirectUrl).toBe(
        "http://localhost:3001/oauth/mcp/callback",
      );
    });

    it("should return correct clientMetadata", async () => {
      const { DatabaseOAuthClientProvider } =
        await import("./mcp-oauth-provider.ts");
      const callbackUrl = "http://localhost:3001/oauth/mcp/callback";
      const provider = new DatabaseOAuthClientProvider(
        { id: "mcp-1" } as any,
        callbackUrl,
      );
      expect(provider.clientMetadata).toEqual({
        redirect_uris: [callbackUrl],
        client_name: "Platypus",
        token_endpoint_auth_method: "client_secret_post",
      });
    });

    it("should include scope in clientMetadata when oauthRequestedScope is set", async () => {
      const { DatabaseOAuthClientProvider } =
        await import("./mcp-oauth-provider.ts");
      const callbackUrl = "http://localhost:3001/oauth/mcp/callback";
      const provider = new DatabaseOAuthClientProvider(
        {
          id: "mcp-1",
          oauthRequestedScope: "https://www.googleapis.com/auth/calendar",
        } as any,
        callbackUrl,
      );
      expect(provider.clientMetadata).toEqual({
        redirect_uris: [callbackUrl],
        client_name: "Platypus",
        token_endpoint_auth_method: "client_secret_post",
        scope: "https://www.googleapis.com/auth/calendar",
      });
    });

    it("should return undefined tokens when no access token exists", async () => {
      const { DatabaseOAuthClientProvider } =
        await import("./mcp-oauth-provider.ts");
      const provider = new DatabaseOAuthClientProvider(
        { id: "mcp-1" } as any,
        "http://localhost:3001/oauth/mcp/callback",
      );

      mockDb.limit.mockResolvedValueOnce([{ oauthAccessToken: null }]);
      const tokens = await provider.tokens();
      expect(tokens).toBeUndefined();
    });

    it("should return tokens from database", async () => {
      const { DatabaseOAuthClientProvider } =
        await import("./mcp-oauth-provider.ts");
      const provider = new DatabaseOAuthClientProvider(
        { id: "mcp-1" } as any,
        "http://localhost:3001/oauth/mcp/callback",
      );

      const futureDate = new Date(Date.now() + 3600 * 1000);
      mockDb.limit.mockResolvedValueOnce([
        {
          oauthAccessToken: "access-123",
          oauthRefreshToken: "refresh-456",
          oauthTokenExpiresAt: futureDate,
          oauthScope: "read write",
        },
      ]);

      const tokens = await provider.tokens();
      expect(tokens).toMatchObject({
        access_token: "access-123",
        token_type: "bearer",
        refresh_token: "refresh-456",
        scope: "read write",
      });
      expect(tokens!.expires_in).toBeGreaterThan(0);
    });

    it("should save tokens to database", async () => {
      const { DatabaseOAuthClientProvider } =
        await import("./mcp-oauth-provider.ts");
      const provider = new DatabaseOAuthClientProvider(
        { id: "mcp-1" } as any,
        "http://localhost:3001/oauth/mcp/callback",
      );

      mockDb.where.mockResolvedValueOnce(undefined);

      await provider.saveTokens({
        access_token: "new-access",
        token_type: "bearer",
        refresh_token: "new-refresh",
        expires_in: 3600,
        scope: "read",
      });

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          oauthAccessToken: "new-access",
          oauthRefreshToken: "new-refresh",
          oauthScope: "read",
        }),
      );
    });

    it("should return client information from database", async () => {
      const { DatabaseOAuthClientProvider } =
        await import("./mcp-oauth-provider.ts");
      const provider = new DatabaseOAuthClientProvider(
        { id: "mcp-1" } as any,
        "http://localhost:3001/oauth/mcp/callback",
      );

      mockDb.limit.mockResolvedValueOnce([
        {
          oauthClientId: "client-id-123",
          oauthClientSecret: "client-secret-456",
        },
      ]);

      const info = await provider.clientInformation();
      expect(info).toEqual({
        client_id: "client-id-123",
        client_secret: "client-secret-456",
      });
    });

    it("should return undefined client information when no client id", async () => {
      const { DatabaseOAuthClientProvider } =
        await import("./mcp-oauth-provider.ts");
      const provider = new DatabaseOAuthClientProvider(
        { id: "mcp-1" } as any,
        "http://localhost:3001/oauth/mcp/callback",
      );

      mockDb.limit.mockResolvedValueOnce([{ oauthClientId: null }]);
      const info = await provider.clientInformation();
      expect(info).toBeUndefined();
    });

    it("should save client information to database", async () => {
      const { DatabaseOAuthClientProvider } =
        await import("./mcp-oauth-provider.ts");
      const provider = new DatabaseOAuthClientProvider(
        { id: "mcp-1" } as any,
        "http://localhost:3001/oauth/mcp/callback",
      );

      mockDb.where.mockResolvedValueOnce(undefined);

      await provider.saveClientInformation({
        client_id: "new-client-id",
        client_secret: "new-client-secret",
      });

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          oauthClientId: "new-client-id",
          oauthClientSecret: "new-client-secret",
        }),
      );
    });

    it("should capture authorization URL via redirectToAuthorization", async () => {
      const { DatabaseOAuthClientProvider } =
        await import("./mcp-oauth-provider.ts");
      const provider = new DatabaseOAuthClientProvider(
        { id: "mcp-1" } as any,
        "http://localhost:3001/oauth/mcp/callback",
      );

      const authUrl = new URL("https://auth.example.com/authorize?foo=bar");
      await provider.redirectToAuthorization(authUrl);
      expect(provider.getPendingAuthUrl()).toEqual(authUrl);
    });

    it("should return undefined pending auth URL when not set", async () => {
      const { DatabaseOAuthClientProvider } =
        await import("./mcp-oauth-provider.ts");
      const provider = new DatabaseOAuthClientProvider(
        { id: "mcp-1" } as any,
        "http://localhost:3001/oauth/mcp/callback",
      );
      expect(provider.getPendingAuthUrl()).toBeUndefined();
    });

    it("should generate and return state", async () => {
      const { DatabaseOAuthClientProvider } =
        await import("./mcp-oauth-provider.ts");
      const provider = new DatabaseOAuthClientProvider(
        { id: "mcp-1" } as any,
        "http://localhost:3001/oauth/mcp/callback",
      );

      const state = await provider.state();
      expect(state).toBeTruthy();
      // Should return the same state on subsequent calls
      const state2 = await provider.state();
      expect(state2).toBe(state);
    });

    it("should save state to mcpOauthState table", async () => {
      const { DatabaseOAuthClientProvider } =
        await import("./mcp-oauth-provider.ts");
      const provider = new DatabaseOAuthClientProvider(
        { id: "mcp-1" } as any,
        "http://localhost:3001/oauth/mcp/callback",
      );

      mockDb.values.mockResolvedValueOnce(undefined);

      await provider.saveState("test-state-123");
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "test-state-123",
          mcpId: "mcp-1",
          redirectUri: "http://localhost:3001/oauth/mcp/callback",
        }),
      );
    });

    it("should read code verifier from mcpOauthState via state lookup", async () => {
      const { DatabaseOAuthClientProvider } =
        await import("./mcp-oauth-provider.ts");
      const provider = new DatabaseOAuthClientProvider(
        { id: "mcp-1" } as any,
        "http://localhost:3001/oauth/mcp/callback",
      );

      provider.setStateForLookup("state-123");
      mockDb.limit.mockResolvedValueOnce([
        { codeVerifier: "verifier-abc", id: "state-123" },
      ]);

      const verifier = await provider.codeVerifier();
      expect(verifier).toBe("verifier-abc");
    });

    it("should throw when no code verifier found", async () => {
      const { DatabaseOAuthClientProvider } =
        await import("./mcp-oauth-provider.ts");
      const provider = new DatabaseOAuthClientProvider(
        { id: "mcp-1" } as any,
        "http://localhost:3001/oauth/mcp/callback",
      );

      await expect(provider.codeVerifier()).rejects.toThrow(
        "No code verifier found",
      );
    });

    it("should return stored state via storedState()", async () => {
      const { DatabaseOAuthClientProvider } =
        await import("./mcp-oauth-provider.ts");
      const provider = new DatabaseOAuthClientProvider(
        { id: "mcp-1" } as any,
        "http://localhost:3001/oauth/mcp/callback",
      );

      expect(await provider.storedState()).toBeUndefined();
      provider.setStateForLookup("state-456");
      expect(await provider.storedState()).toBe("state-456");
    });
  });
});
