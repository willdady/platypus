import { describe, it, expect } from "vitest";
import {
  redactMcpSecrets,
  redactProviderSecrets,
} from "./credential-redaction.ts";

describe("redactProviderSecrets", () => {
  const row = {
    id: "p1",
    name: "OpenAI",
    apiKey: "sk-secret",
    headers: { Authorization: "Bearer secret" },
    baseUrl: "https://api.openai.com",
  };

  it("returns the row untouched when the caller may manage it", () => {
    expect(redactProviderSecrets(row, { reveal: true })).toBe(row);
  });

  it("fails closed when no option is passed", () => {
    // A new call site that forgets the flag must redact, not leak.
    expect(redactProviderSecrets(row)).not.toHaveProperty("apiKey");
  });

  it("removes the credential fields and keeps the rest", () => {
    const out = redactProviderSecrets(row, { reveal: false });
    expect(out).not.toHaveProperty("apiKey");
    expect(out).not.toHaveProperty("headers");
    expect(out).toMatchObject({
      id: "p1",
      name: "OpenAI",
      baseUrl: "https://api.openai.com",
    });
    expect(JSON.stringify(out)).not.toContain("sk-secret");
    expect(JSON.stringify(out)).not.toContain("Bearer secret");
  });

  it("reports whether a credential is configured without revealing it", () => {
    expect(redactProviderSecrets(row, { reveal: false })).toMatchObject({
      apiKeySet: { configured: true },
      headersSet: { configured: true },
    });
    expect(
      redactProviderSecrets({ ...row, apiKey: "", headers: null }, {}),
    ).toMatchObject({
      apiKeySet: { configured: false },
      headersSet: { configured: false },
    });
  });

  it("treats an empty header object as unconfigured", () => {
    // `{}` round-trips out of jsonb for a Provider saved with no custom headers;
    // reporting it as configured would send the form hunting for a value that
    // isn't there.
    expect(redactProviderSecrets({ ...row, headers: {} }, {})).toMatchObject({
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

  it("returns the row untouched when the caller may manage it", () => {
    expect(redactMcpSecrets(row, { reveal: true })).toBe(row);
  });

  it("fails closed when no option is passed", () => {
    expect(redactMcpSecrets(row)).not.toHaveProperty("bearerToken");
  });

  it("removes the request credentials and keeps the rest", () => {
    const out = redactMcpSecrets(row, { reveal: false });
    expect(out).not.toHaveProperty("bearerToken");
    expect(out).not.toHaveProperty("headers");
    expect(out).toMatchObject({
      id: "mcp-1",
      name: "Rovo",
      authType: "Bearer",
    });
    expect(JSON.stringify(out)).not.toContain("tok-secret");
    expect(JSON.stringify(out)).not.toContain("hdr-secret");
  });

  it("reports presence for an OAuth MCP that has no bearer token", () => {
    const out = redactMcpSecrets(
      { id: "m", authType: "OAuth", bearerToken: null },
      {},
    );
    expect(out).toMatchObject({ bearerTokenSet: { configured: false } });
  });
});
