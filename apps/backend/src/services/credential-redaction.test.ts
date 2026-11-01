import { describe, it, expect } from "vitest";
import {
  redactMcpSecrets,
  redactProviderSecrets,
  mcpReadModel,
  providerReadModel,
} from "./credential-redaction.ts";
import type { McpRecord } from "./mcp-oauth-provider.ts";

describe("redactProviderSecrets", () => {
  const row = {
    id: "p1",
    name: "OpenAI",
    apiKey: "sk-secret",
    headers: { Authorization: "Bearer secret" },
    baseUrl: "https://api.openai.com",
  };

  it("keeps the credential values when the caller may manage it", () => {
    expect(redactProviderSecrets(row, { reveal: true })).toMatchObject({
      apiKey: "sk-secret",
      headers: { Authorization: "Bearer secret" },
      apiKeySet: { configured: true },
      headersSet: { configured: true },
    });
  });

  it("reports presence whatever the reveal decision", () => {
    // One type, one set of presence keys: only the value keys differ.
    for (const reveal of [true, false]) {
      const out = redactProviderSecrets(row, { reveal });
      expect(out.apiKeySet).toEqual({ configured: true });
      expect(out.headersSet).toEqual({ configured: true });
    }
  });

  it("removes the credential values but reports their presence", () => {
    const out = redactProviderSecrets(row, { reveal: false });
    expect(out).not.toHaveProperty("apiKey");
    expect(out).not.toHaveProperty("headers");
    expect(out).toMatchObject({
      id: "p1",
      name: "OpenAI",
      baseUrl: "https://api.openai.com",
      apiKeySet: { configured: true },
      headersSet: { configured: true },
    });
    expect(JSON.stringify(out)).not.toContain("sk-secret");
    expect(JSON.stringify(out)).not.toContain("Bearer secret");
  });

  it("reports whether a credential is configured without revealing it", () => {
    expect(
      redactProviderSecrets(
        { ...row, apiKey: "", headers: null },
        {
          reveal: false,
        },
      ),
    ).toMatchObject({
      apiKeySet: { configured: false },
      headersSet: { configured: false },
    });
  });

  it("treats an empty header object as unconfigured", () => {
    // `{}` round-trips out of jsonb for a Provider saved with no custom headers;
    // reporting it as configured would send the form hunting for a value that
    // isn't there.
    expect(
      redactProviderSecrets({ ...row, headers: {} }, { reveal: false }),
    ).toMatchObject({
      headersSet: { configured: false },
    });
  });
});

describe("redactMcpSecrets", () => {
  const row = {
    id: "mcp-1",
    name: "Rovo",
    authType: "Bearer",
    bearerToken: "tok-secret",
    headers: { "X-Api-Key": "hdr-secret" },
  };

  it("keeps the request credentials when the caller may manage it", () => {
    expect(redactMcpSecrets(row, { reveal: true })).toMatchObject({
      bearerToken: "tok-secret",
      headers: { "X-Api-Key": "hdr-secret" },
      bearerTokenSet: { configured: true },
      headersSet: { configured: true },
    });
  });

  it("removes the credential values but reports their presence", () => {
    const out = redactMcpSecrets(row, { reveal: false });
    expect(out).not.toHaveProperty("bearerToken");
    expect(out).not.toHaveProperty("headers");
    expect(out).toMatchObject({
      id: "mcp-1",
      name: "Rovo",
      authType: "Bearer",
      bearerTokenSet: { configured: true },
      headersSet: { configured: true },
    });
    expect(JSON.stringify(out)).not.toContain("tok-secret");
    expect(JSON.stringify(out)).not.toContain("hdr-secret");
  });

  it("reports presence for an OAuth MCP that has no bearer token", () => {
    const out = redactMcpSecrets(
      { id: "m", authType: "OAuth", bearerToken: null },
      { reveal: false },
    );
    expect(out).toMatchObject({ bearerTokenSet: { configured: false } });
  });
});

describe("read models", () => {
  // The OAuth strip is unconditional and the credential redaction is not.
  // Pairing them here is the point of the read model: a route that reached for
  // redactMcpSecrets alone would answer with the minted tokens still attached.
  const mcp = {
    id: "mcp-1",
    name: "Rovo",
    authType: "OAuth",
    bearerToken: "tok-secret",
    headers: { Authorization: "hdr-secret" },
    oauthAccessToken: "oauth-access",
    oauthRefreshToken: "oauth-refresh",
    oauthClientSecret: "oauth-client",
    oauthScope: "read",
    oauthTokenExpiresAt: new Date(0),
    oauthAuthorizationServer: {
      authorizationServerUrl: "https://auth.example.com/",
      tokenEndpoint: "https://auth.example.com/token",
    },
    oauthClientDynamicallyRegistered: true,
    lastKnownToolListing: { tools: [] },
    lastKnownToolListingFetchedAt: new Date(0),
    lastFetchFailedAt: new Date(0),
  } as unknown as McpRecord;

  it("strips minted OAuth secrets even when credentials are revealed", () => {
    const out = mcpReadModel(mcp, { reveal: true, scope: "workspace" });
    const json = JSON.stringify(out);
    expect(json).not.toContain("oauth-access");
    expect(json).not.toContain("oauth-refresh");
    expect(json).not.toContain("oauth-client");
    // Operator-entered config still reads back for a caller who may manage it.
    expect(json).toContain("tok-secret");
    expect(out).toMatchObject({ oauthAuthorized: true });
    // Internal to a Chat turn (ADR-0029), and no part of the MCP a reader edits.
    expect(out).not.toHaveProperty("lastKnownToolListing");
    expect(out).not.toHaveProperty("lastKnownToolListingFetchedAt");
    expect(out).not.toHaveProperty("lastFetchFailedAt");
    expect(out).not.toHaveProperty("oauthAuthorizationServer");
    expect(out).not.toHaveProperty("oauthClientDynamicallyRegistered");
  });

  it("strips both secret classes when credentials are not revealed", () => {
    const json = JSON.stringify(
      mcpReadModel(mcp, { reveal: false, scope: "workspace" }),
    );
    expect(json).not.toContain("oauth-access");
    expect(json).not.toContain("tok-secret");
    expect(json).not.toContain("hdr-secret");
  });

  it("always carries the resolved scope, on both surfaces", () => {
    expect(
      mcpReadModel(mcp, { reveal: false, scope: "workspace" }),
    ).toMatchObject({ scope: "workspace" });
    expect(
      mcpReadModel(mcp, { reveal: false, scope: "organization" }),
    ).toMatchObject({ scope: "organization" });
    expect(
      providerReadModel({ id: "p", apiKey: "k" } as never, {
        reveal: false,
        scope: "organization",
      }),
    ).toMatchObject({ scope: "organization" });
  });
});
