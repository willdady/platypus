import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { mockNanoid } from "../test-setup.ts";
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";
import {
  buildMcpTransportConfig,
  DatabaseOAuthClientProvider,
  oauthFetchFn,
  type McpRecord,
} from "./mcp-oauth-provider.ts";

const CALLBACK = "http://localhost:3001/oauth/mcp/callback";

const mcpRecord = (fields: Record<string, unknown>) =>
  ({
    id: "mcp-1",
    url: "http://mcp.example.com",
    ...fields,
  }) as unknown as McpRecord;

describe("mcp-oauth-provider", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  describe("buildOAuthCallbackUrl", () => {
    // The URL is cached at module scope, so each case imports a fresh copy.
    beforeEach(() => {
      delete process.env.FRONTEND_URL;
      vi.resetModules();
    });

    afterEach(() => {
      delete process.env.FRONTEND_URL;
    });

    it.each([
      [undefined, "http://localhost:3001/oauth/mcp/callback"],
      ["https://app.example.com", "https://app.example.com/oauth/mcp/callback"],
      [
        "https://app.example.com///",
        "https://app.example.com/oauth/mcp/callback",
      ],
    ])("builds the callback from FRONTEND_URL=%s", async (env, expected) => {
      if (env) process.env.FRONTEND_URL = env;
      const { buildOAuthCallbackUrl } = await import("./mcp-oauth-provider.ts");
      expect(buildOAuthCallbackUrl()).toBe(expected);
    });

    it("keeps the first URL it built for the process lifetime", async () => {
      const { buildOAuthCallbackUrl } = await import("./mcp-oauth-provider.ts");
      buildOAuthCallbackUrl();
      process.env.FRONTEND_URL = "https://changed.example.com";
      expect(buildOAuthCallbackUrl()).toBe(CALLBACK);
    });
  });

  describe("buildMcpTransportConfig", () => {
    const base = { type: "http", url: "http://mcp.example.com" };

    it.each([
      ["no auth, no headers", { authType: "None" }, base],
      [
        "no auth, undefined headers",
        { authType: "None", headers: undefined },
        base,
      ],
      ["no auth, empty headers", { authType: "None", headers: {} }, base],
      [
        "no auth, custom headers",
        { authType: "None", headers: { "X-Custom": "value" } },
        { ...base, headers: { "X-Custom": "value" } },
      ],
      [
        "Bearer auth",
        { authType: "Bearer", bearerToken: "my-secret-token" },
        { ...base, headers: { Authorization: "Bearer my-secret-token" } },
      ],
      [
        "Bearer auth over a custom Authorization header",
        {
          authType: "Bearer",
          bearerToken: "my-token",
          headers: { "X-Custom": "value", Authorization: "overridden" },
        },
        {
          ...base,
          headers: { "X-Custom": "value", Authorization: "Bearer my-token" },
        },
      ],
      [
        "OAuth without an access token",
        { authType: "OAuth", oauthAccessToken: null },
        base,
      ],
    ])("builds the transport for %s", (_label, fields, expected) => {
      expect(buildMcpTransportConfig(mcpRecord(fields))).toEqual(expected);
    });

    it("attaches a DB-backed auth provider for OAuth with an access token, keeping custom headers", () => {
      const config = buildMcpTransportConfig(
        mcpRecord({
          authType: "OAuth",
          oauthAccessToken: "access-token-123",
          headers: { "X-Custom": "value" },
        }),
      );

      expect(config.headers).toEqual({ "X-Custom": "value" });
      expect(config.authProvider).toBeInstanceOf(DatabaseOAuthClientProvider);
      expect(config.authProvider?.redirectUrl).toMatch(
        /\/oauth\/mcp\/callback$/,
      );
    });
  });

  describe("oauthFetchFn", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("should return original response when ok", async () => {
      const mockResponse = new Response(JSON.stringify({ data: "test" }), {
        status: 200,
      });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      await expect(oauthFetchFn("http://example.com")).resolves.toBe(
        mockResponse,
      );
    });

    it("should reconstruct non-ok responses to fix instanceof check", async () => {
      const mockResponse = new Response("Bad Request", {
        status: 400,
        statusText: "Bad Request",
      });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      const result = await oauthFetchFn("http://example.com");
      expect(result).not.toBe(mockResponse);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(400);
      expect(result.statusText).toBe("Bad Request");
      expect(result instanceof Response).toBe(true);
      expect(await result.text()).toBe("Bad Request");
    });
  });

  describe("DatabaseOAuthClientProvider", () => {
    const mcpRow = (id: string, extra: Row = {}): Row => ({
      id,
      oauthAccessToken: null,
      oauthRefreshToken: null,
      oauthTokenExpiresAt: null,
      oauthScope: null,
      oauthClientId: null,
      oauthClientSecret: null,
      ...extra,
    });

    // `mcp-2` holds credentials of its own that `mcp-1`'s provider must never
    // read or overwrite.
    const world = (mine: Row = {}) =>
      seedDb({
        mcp: [
          mcpRow("mcp-1", mine),
          mcpRow("mcp-2", {
            oauthAccessToken: "other-access",
            oauthClientId: "other-client",
          }),
        ],
        mcp_oauth_state: [
          { id: "other-state", mcpId: "mcp-2", codeVerifier: "other-verifier" },
        ],
      });

    const provider = (fields: Record<string, unknown> = {}) =>
      new DatabaseOAuthClientProvider(mcpRecord(fields), CALLBACK);

    const row = (fake: ReturnType<typeof world>, table: string, id: string) =>
      fake.tables[table].find((r) => r.id === id);

    it("advertises the callback as its redirect URL and client metadata", () => {
      expect(provider().redirectUrl).toBe(CALLBACK);
      expect(provider().clientMetadata).toEqual({
        redirect_uris: [CALLBACK],
        client_name: "Platypus",
        token_endpoint_auth_method: "client_secret_post",
      });
      expect(
        provider({ oauthRequestedScope: "calendar" }).clientMetadata,
      ).toMatchObject({ scope: "calendar" });
    });

    describe("tokens", () => {
      it("returns undefined when this MCP has no access token", async () => {
        world();
        await expect(provider().tokens()).resolves.toBeUndefined();
      });

      it("returns this MCP's stored tokens", async () => {
        world({
          oauthAccessToken: "access-123",
          oauthRefreshToken: "refresh-456",
          oauthTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
          oauthScope: "read write",
        });

        const tokens = await provider().tokens();

        expect(tokens).toMatchObject({
          access_token: "access-123",
          token_type: "bearer",
          refresh_token: "refresh-456",
          scope: "read write",
        });
        expect(tokens!.expires_in).toBeGreaterThan(3590);
        expect(tokens!.expires_in).toBeLessThanOrEqual(3600);
      });

      it("omits the optional fields it has no value for", async () => {
        world({ oauthAccessToken: "access-123" });
        await expect(provider().tokens()).resolves.toEqual({
          access_token: "access-123",
          token_type: "bearer",
        });
      });

      it("saves tokens to this MCP's row only", async () => {
        const fake = world();

        await provider().saveTokens({
          access_token: "new-access",
          token_type: "bearer",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: "read",
        });

        expect(row(fake, "mcp", "mcp-1")).toMatchObject({
          oauthAccessToken: "new-access",
          oauthRefreshToken: "new-refresh",
          oauthTokenExpiresAt: expect.any(Date) as unknown,
          oauthScope: "read",
        });
        expect(row(fake, "mcp", "mcp-2")?.oauthAccessToken).toBe(
          "other-access",
        );
      });

      it("clears the optional token fields a refresh does not return", async () => {
        const fake = world({
          oauthRefreshToken: "old",
          oauthTokenExpiresAt: new Date(),
          oauthScope: "old",
        });

        await provider().saveTokens({
          access_token: "a",
          token_type: "bearer",
        });

        expect(row(fake, "mcp", "mcp-1")).toMatchObject({
          oauthAccessToken: "a",
          oauthRefreshToken: null,
          oauthTokenExpiresAt: null,
          oauthScope: null,
        });
      });
    });

    describe("client information", () => {
      it("returns this MCP's registered client", async () => {
        world({ oauthClientId: "client-id-123", oauthClientSecret: "secret" });
        await expect(provider().clientInformation()).resolves.toEqual({
          client_id: "client-id-123",
          client_secret: "secret",
        });
      });

      it("omits a missing client secret", async () => {
        world({ oauthClientId: "client-id-123" });
        await expect(provider().clientInformation()).resolves.toEqual({
          client_id: "client-id-123",
        });
      });

      it("returns undefined when this MCP has no client id", async () => {
        world();
        await expect(provider().clientInformation()).resolves.toBeUndefined();
      });

      it("saves client information to this MCP's row only", async () => {
        const fake = world();

        await provider().saveClientInformation({ client_id: "new-client-id" });

        expect(row(fake, "mcp", "mcp-1")).toMatchObject({
          oauthClientId: "new-client-id",
          oauthClientSecret: null,
        });
        expect(row(fake, "mcp", "mcp-2")?.oauthClientId).toBe("other-client");
      });
    });

    describe("redirectToAuthorization", () => {
      it("captures the authorization URL unchanged", () => {
        const p = provider();
        expect(p.getPendingAuthUrl()).toBeUndefined();

        p.redirectToAuthorization(
          new URL("https://auth.example.com/authorize?foo=bar"),
        );

        expect(p.getPendingAuthUrl()?.toString()).toBe(
          "https://auth.example.com/authorize?foo=bar",
        );
      });

      it.each(["accounts.google.com", "google.com"])(
        "asks %s for an offline, re-consented grant so a refresh token is issued",
        (host) => {
          const p = provider();
          p.redirectToAuthorization(new URL(`https://${host}/o/oauth2/auth`));

          const params = p.getPendingAuthUrl()!.searchParams;
          expect(params.get("access_type")).toBe("offline");
          expect(params.get("prompt")).toBe("consent");
        },
      );

      it("does not treat a look-alike host as Google", () => {
        const p = provider();
        p.redirectToAuthorization(new URL("https://notgoogle.com/auth"));
        expect(p.getPendingAuthUrl()!.searchParams.has("prompt")).toBe(false);
      });
    });

    describe("state and code verifier", () => {
      it("generates one state per provider", () => {
        mockNanoid.mockReturnValueOnce("state-1");
        const p = provider();
        expect(p.state()).toBe("state-1");
        expect(p.state()).toBe("state-1");
      });

      it("persists the state with the verifier saved before it", async () => {
        const fake = world();
        const p = provider();

        await p.saveCodeVerifier("verifier-early");
        await p.saveState("state-123");

        expect(row(fake, "mcp_oauth_state", "state-123")).toEqual({
          id: "state-123",
          mcpId: "mcp-1",
          codeVerifier: "verifier-early",
          redirectUri: CALLBACK,
          expiresAt: expect.any(Date) as unknown,
        });
      });

      it("writes a verifier saved after the state onto that state's row only", async () => {
        const fake = world();
        const p = provider();

        await p.saveState("state-123");
        await p.saveCodeVerifier("verifier-late");

        expect(row(fake, "mcp_oauth_state", "state-123")?.codeVerifier).toBe(
          "verifier-late",
        );
        expect(row(fake, "mcp_oauth_state", "other-state")?.codeVerifier).toBe(
          "other-verifier",
        );
      });

      it("reads the code verifier of the state it was given to look up", async () => {
        const fake = world();
        fake.tables.mcp_oauth_state.push({
          id: "state-123",
          mcpId: "mcp-1",
          codeVerifier: "verifier-abc",
        });
        const p = provider();

        expect(p.storedState()).toBeUndefined();
        p.setStateForLookup("state-123");

        expect(p.storedState()).toBe("state-123");
        await expect(p.codeVerifier()).resolves.toBe("verifier-abc");
      });

      it.each([
        ["no state to look up", undefined],
        ["an unknown state", "gone"],
      ])("throws when there is %s", async (_label, state) => {
        world();
        const p = provider();
        if (state) p.setStateForLookup(state);

        await expect(p.codeVerifier()).rejects.toThrow(
          "No code verifier found",
        );
      });
    });
  });
});
