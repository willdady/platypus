import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  mockNoSession,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";

vi.mock("@ai-sdk/mcp", () => ({
  auth: vi.fn(),
  experimental_createMCPClient: vi.fn().mockResolvedValue({
    tools: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../services/mcp-oauth-provider.ts", () => {
  class MockDatabaseOAuthClientProvider {
    setStateForLookup = vi.fn();
  }
  return {
    buildOAuthCallbackUrl: vi
      .fn()
      .mockReturnValue("http://localhost:3001/oauth/mcp/callback"),
    DatabaseOAuthClientProvider: MockDatabaseOAuthClientProvider,
    oauthFetchFn: vi.fn(),
  };
});

import { auth as mcpAuth } from "@ai-sdk/mcp";

describe("MCP OAuth Callback Route", () => {
  const baseUrl = "/oauth/mcp/callback";

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    // Default: where returns mockDb for chaining, but also resolves for terminal calls
    mockDb.where.mockImplementation(() => mockDb);
  });

  it("should return 401 when not authenticated", async () => {
    mockNoSession();

    const res = await app.request(baseUrl, {
      method: "POST",
      body: JSON.stringify({ code: "auth-code", state: "state-123" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(401);
  });

  it("should return 400 for invalid state", async () => {
    mockSession();
    mockDb.limit.mockResolvedValueOnce([]); // No state record found

    const res = await app.request(baseUrl, {
      method: "POST",
      body: JSON.stringify({ code: "auth-code", state: "invalid-state" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid or expired OAuth state",
    });
  });

  it("should return 400 for expired state", async () => {
    mockSession();
    const expiredDate = new Date(Date.now() - 60000); // 1 minute ago
    mockDb.limit.mockResolvedValueOnce([
      { id: "state-123", mcpId: "mcp-1", expiresAt: expiredDate },
    ]);

    const res = await app.request(baseUrl, {
      method: "POST",
      body: JSON.stringify({ code: "auth-code", state: "state-123" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "OAuth state has expired",
    });
  });

  it("should return 404 when MCP not found", async () => {
    mockSession();
    const futureDate = new Date(Date.now() + 600000);
    mockDb.limit
      .mockResolvedValueOnce([
        { id: "state-123", mcpId: "mcp-1", expiresAt: futureDate },
      ]) // state lookup
      .mockResolvedValueOnce([]); // mcp lookup - not found

    const res = await app.request(baseUrl, {
      method: "POST",
      body: JSON.stringify({ code: "auth-code", state: "state-123" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "MCP not found" });
  });

  it("should return 400 when MCP URL is not configured", async () => {
    mockSession();
    const futureDate = new Date(Date.now() + 600000);
    mockDb.limit
      .mockResolvedValueOnce([
        { id: "state-123", mcpId: "mcp-1", expiresAt: futureDate },
      ]) // state lookup
      .mockResolvedValueOnce([{ id: "mcp-1", url: null, workspaceId: "ws-1" }]); // mcp lookup - no URL

    const res = await app.request(baseUrl, {
      method: "POST",
      body: JSON.stringify({ code: "auth-code", state: "state-123" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "MCP URL is not configured",
    });
  });

  it("should return 404 when workspace not found", async () => {
    mockSession();
    const futureDate = new Date(Date.now() + 600000);
    mockDb.limit
      .mockResolvedValueOnce([
        { id: "state-123", mcpId: "mcp-1", expiresAt: futureDate },
      ]) // state lookup
      .mockResolvedValueOnce([
        { id: "mcp-1", url: "http://mcp.example.com", workspaceId: "ws-1" },
      ]) // mcp lookup
      .mockResolvedValueOnce([]); // workspace lookup - not found

    const res = await app.request(baseUrl, {
      method: "POST",
      body: JSON.stringify({ code: "auth-code", state: "state-123" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Workspace not found" });
  });

  it("should return success when OAuth completes successfully", async () => {
    mockSession();
    const futureDate = new Date(Date.now() + 600000);
    mockDb.limit
      .mockResolvedValueOnce([
        { id: "state-123", mcpId: "mcp-1", expiresAt: futureDate },
      ]) // state lookup
      .mockResolvedValueOnce([
        { id: "mcp-1", url: "http://mcp.example.com", workspaceId: "ws-1" },
      ]) // mcp lookup
      .mockResolvedValueOnce([{ id: "ws-1", organizationId: "org-1" }]); // workspace lookup

    vi.mocked(mcpAuth).mockResolvedValueOnce("AUTHORIZED");

    const res = await app.request(baseUrl, {
      method: "POST",
      body: JSON.stringify({ code: "auth-code", state: "state-123" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      orgId: "org-1",
      workspaceId: "ws-1",
      mcpId: "mcp-1",
    });
  });

  it("should return 500 for unexpected OAuth result", async () => {
    mockSession();
    const futureDate = new Date(Date.now() + 600000);
    mockDb.limit
      .mockResolvedValueOnce([
        { id: "state-123", mcpId: "mcp-1", expiresAt: futureDate },
      ])
      .mockResolvedValueOnce([
        { id: "mcp-1", url: "http://mcp.example.com", workspaceId: "ws-1" },
      ])
      .mockResolvedValueOnce([{ id: "ws-1", organizationId: "org-1" }]);

    vi.mocked(mcpAuth).mockResolvedValueOnce("REDIRECT");

    const res = await app.request(baseUrl, {
      method: "POST",
      body: JSON.stringify({ code: "auth-code", state: "state-123" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("Unexpected OAuth result");
  });

  it("should return 500 when OAuth throws an error", async () => {
    mockSession();
    const futureDate = new Date(Date.now() + 600000);
    mockDb.limit
      .mockResolvedValueOnce([
        { id: "state-123", mcpId: "mcp-1", expiresAt: futureDate },
      ])
      .mockResolvedValueOnce([
        { id: "mcp-1", url: "http://mcp.example.com", workspaceId: "ws-1" },
      ])
      .mockResolvedValueOnce([{ id: "ws-1", organizationId: "org-1" }]);

    vi.mocked(mcpAuth).mockRejectedValueOnce(
      new Error("Token exchange failed"),
    );

    const res = await app.request(baseUrl, {
      method: "POST",
      body: JSON.stringify({ code: "auth-code", state: "state-123" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Token exchange failed",
    });
  });
});
