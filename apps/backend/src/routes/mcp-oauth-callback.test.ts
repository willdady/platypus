import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockSession,
  mockNoSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
  type Store,
} from "../test-utils.ts";
import app from "../server.ts";

vi.mock("@ai-sdk/mcp", () => ({
  auth: vi.fn(),
  createMCPClient: vi.fn().mockResolvedValue({
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
  });

  const post = (state: string) =>
    app.request(baseUrl, {
      method: "POST",
      body: JSON.stringify({ code: "auth-code", state }),
      headers: { "Content-Type": "application/json" },
    });

  const futureDate = () => new Date(Date.now() + 600000);
  const expiredDate = () => new Date(Date.now() - 60000);

  const oauthState = (over: Row = {}): Row => ({
    id: "state-123",
    mcpId: "mcp-1",
    userId: "user-1",
    codeVerifier: "verifier",
    redirectUri: "http://localhost:3001/oauth/mcp/callback",
    expiresAt: futureDate(),
    ...over,
  });

  const mcpRow = (over: Row = {}): Row => ({
    id: "mcp-1",
    name: "MCP",
    slug: "mcp",
    url: "http://mcp.example.com",
    authType: "OAuth",
    organizationId: null,
    workspaceId: "ws-1",
    ...over,
  });

  const workspaceRow = (over: Row = {}): Row => ({
    id: "ws-1",
    organizationId: "org-1",
    ownerId: "user-1",
    name: "Workspace",
    ...over,
  });

  const otherMcp = mcpRow({
    id: "mcp-other",
    name: "Other MCP",
    slug: "other_mcp",
    organizationId: "org-2",
    workspaceId: null,
  });

  const otherWorkspace = workspaceRow({
    id: "ws-other",
    organizationId: "org-2",
  });

  const world = (rows: Store = {}): FakeDb =>
    seedDb({
      mcp_oauth_state: [oauthState({ id: "state-other" }), oauthState()],
      mcp: [otherMcp, mcpRow()],
      workspace: [otherWorkspace, workspaceRow()],
      ...rows,
    });

  it("should return 401 when not authenticated", async () => {
    mockNoSession();

    const res = await post("state-123");

    expect(res.status).toBe(401);
  });

  it("should return 400 for invalid state", async () => {
    mockSession();
    world();

    const res = await post("invalid-state");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid or expired OAuth state",
    });
  });

  it("should return 400 for expired state", async () => {
    mockSession();
    const fake = world({
      mcp_oauth_state: [
        oauthState({ id: "state-other" }),
        oauthState({ expiresAt: expiredDate() }),
      ],
    });

    const res = await post("state-123");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "OAuth state has expired",
    });
    expect(fake.tables.mcp_oauth_state.map((row) => row.id)).toEqual([
      "state-other",
    ]);
  });

  it("should return 404 when MCP not found", async () => {
    mockSession();
    world({ mcp: [otherMcp] });

    const res = await post("state-123");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "MCP not found" });
  });

  it("should return 400 when MCP URL is not configured", async () => {
    mockSession();
    world({ mcp: [mcpRow({ url: null })] });

    const res = await post("state-123");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "MCP URL is not configured",
    });
  });

  it("should return 404 when workspace not found", async () => {
    mockSession();
    world({ workspace: [otherWorkspace] });

    const res = await post("state-123");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Workspace not found" });
  });

  it("should return success when OAuth completes successfully", async () => {
    mockSession();
    const fake = world();

    vi.mocked(mcpAuth).mockImplementationOnce(() =>
      Promise.resolve("AUTHORIZED"),
    );

    const res = await post("state-123");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      orgId: "org-1",
      workspaceId: "ws-1",
      mcpId: "mcp-1",
    });
    expect(fake.tables.mcp_oauth_state.map((row) => row.id)).toEqual([
      "state-other",
    ]);
  });

  it("should return 500 for unexpected OAuth result", async () => {
    mockSession();
    world();

    vi.mocked(mcpAuth).mockImplementationOnce(() =>
      Promise.resolve("REDIRECT"),
    );

    const res = await post("state-123");

    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("Unexpected OAuth result");
  });

  it("should return 500 when OAuth throws an error", async () => {
    mockSession();
    const fake = world();

    vi.mocked(mcpAuth).mockImplementationOnce(() =>
      Promise.reject(new Error("Token exchange failed")),
    );

    const res = await post("state-123");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "OAuth token exchange failed",
    });
    expect(
      fake.queries
        .filter((query) => query.kind === "delete")
        .map((q) => q.table),
    ).toEqual(["mcp_oauth_state"]);
  });

  it("should return 403 when another user completes the state", async () => {
    mockSession({ id: "user-2", email: "other@example.com", role: "user" });
    const fake = world();

    const res = await post("state-123");

    expect(res.status).toBe(403);
    expect(mcpAuth).not.toHaveBeenCalled();
    expect(fake.queries.some((query) => query.kind === "delete")).toBe(false);
  });

  it("should return 403 for a state minted outside a user request", async () => {
    mockSession();
    world({
      mcp_oauth_state: [
        oauthState({ id: "state-other" }),
        oauthState({ userId: null }),
      ],
    });

    const res = await post("state-123");

    expect(res.status).toBe(403);
    expect(mcpAuth).not.toHaveBeenCalled();
  });
});
