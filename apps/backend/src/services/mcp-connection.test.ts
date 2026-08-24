import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mockDb, resetMockDb, asDb } from "../test-utils.ts";
import {
  experimental_createMCPClient as createMCPClient,
  auth as mcpAuth,
} from "@ai-sdk/mcp";
import { mcp as mcpTable } from "../db/schema.ts";
import type { McpRecord } from "./mcp-oauth-provider.ts";

/** A real SQL fragment — the functions under test just pass it through to `.where(...)`. */
const someWhere = eq(mcpTable.id, "mcp-1");

vi.mock("@ai-sdk/mcp", () => ({
  experimental_createMCPClient: vi.fn().mockResolvedValue({
    tools: vi.fn().mockResolvedValue({ tool1: {} }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
  auth: vi.fn(),
}));

const baseMcp: McpRecord = {
  id: "mcp-1",
  name: "My Server",
  slug: "my-server",
  url: "http://mcp.example.com",
  headers: null,
  authType: "None",
  bearerToken: null,
  oauthClientId: null,
  oauthClientSecret: null,
  oauthRequestedScope: null,
  oauthAccessToken: null,
  oauthRefreshToken: null,
  oauthTokenExpiresAt: null,
  oauthScope: null,
  organizationId: null,
  workspaceId: "ws-1",
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("mcp-connection", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  describe("probeMcpConnection", () => {
    it("connects and namespaces tool names under the given name", async () => {
      const { probeMcpConnection } = await import("./mcp-connection.ts");
      const result = await probeMcpConnection(
        {
          url: "http://mcp.example.com",
          authType: "None",
          name: "My Server",
        } as never,
        null,
      );
      expect(result).toEqual({
        success: true,
        toolNames: ["my_server__tool1"],
        invalidToolNames: [],
      });
    });

    it("adds a Bearer Authorization header for Bearer auth", async () => {
      const { probeMcpConnection } = await import("./mcp-connection.ts");

      await probeMcpConnection(
        {
          url: "http://mcp.example.com",
          authType: "Bearer",
          bearerToken: "secret-token",
        } as never,
        null,
      );

      const call = vi.mocked(createMCPClient).mock.calls[0]?.[0] as {
        transport: { headers?: Record<string, string> };
      };
      expect(call.transport.headers).toEqual(
        expect.objectContaining({ Authorization: "Bearer secret-token" }),
      );
    });

    it("returns a 404 result when the OAuth mcpId has no resolved row", async () => {
      const { probeMcpConnection } = await import("./mcp-connection.ts");
      const result = await probeMcpConnection(
        { authType: "OAuth", mcpId: "mcp-1" } as never,
        null,
      );
      expect(result).toEqual({
        success: false,
        error: "MCP not found",
        status: 404,
      });
    });

    it("returns a 400 result when the resolved OAuth row has no access token", async () => {
      const { probeMcpConnection } = await import("./mcp-connection.ts");
      const result = await probeMcpConnection(
        { authType: "OAuth", mcpId: "mcp-1" } as never,
        { ...baseMcp, authType: "OAuth", oauthAccessToken: null },
      );
      expect(result).toEqual({
        success: false,
        error: "MCP not yet authorized. Click Authorize first.",
        status: 400,
      });
    });

    it("closes the client and reports the error on a failed connection", async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      vi.mocked(createMCPClient).mockResolvedValueOnce({
        tools: vi.fn().mockRejectedValue(new Error("boom")),
        close,
      } as never);

      const { probeMcpConnection } = await import("./mcp-connection.ts");
      const result = await probeMcpConnection(
        { url: "http://mcp.example.com", authType: "None" } as never,
        null,
      );

      expect(result).toEqual({ success: false, error: "boom", status: 400 });
      expect(close).toHaveBeenCalled();
    });
  });

  describe("clearOAuthTokens", () => {
    it("nulls the four oauth token columns for the given where clause", async () => {
      const { clearOAuthTokens } = await import("./mcp-connection.ts");
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

      await clearOAuthTokens(asDb(mockDb), someWhere);

      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          oauthAccessToken: null,
          oauthRefreshToken: null,
          oauthTokenExpiresAt: null,
          oauthScope: null,
        }),
      );
    });
  });

  describe("authorizeMcpOAuth", () => {
    it("errors when the resolved row's auth type is not OAuth", async () => {
      const { authorizeMcpOAuth } = await import("./mcp-connection.ts");
      const result = await authorizeMcpOAuth(
        asDb(mockDb),
        { ...baseMcp, authType: "None" },
        { force: false, clearTokensWhere: someWhere },
      );
      expect(result).toEqual({
        kind: "error",
        message: "MCP auth type is not OAuth",
        status: 400,
      });
    });

    it("errors when the resolved row has no URL configured", async () => {
      const { authorizeMcpOAuth } = await import("./mcp-connection.ts");
      const result = await authorizeMcpOAuth(
        asDb(mockDb),
        { ...baseMcp, authType: "OAuth", url: null },
        { force: false, clearTokensWhere: someWhere },
      );
      expect(result).toEqual({
        kind: "error",
        message: "MCP URL is not configured",
        status: 400,
      });
    });

    it("clears stored tokens first when force is set, then reports the redirect", async () => {
      vi.mocked(mcpAuth).mockImplementationOnce(
        (provider: { redirectToAuthorization: (url: URL) => void }) => {
          provider.redirectToAuthorization(
            new URL("https://provider.example.com/authorize?x=1"),
          );
          return Promise.resolve("REDIRECT");
        },
      );
      mockDb.returning.mockResolvedValueOnce([]);

      const { authorizeMcpOAuth } = await import("./mcp-connection.ts");
      const result = await authorizeMcpOAuth(
        asDb(mockDb),
        { ...baseMcp, authType: "OAuth" },
        { force: true, clearTokensWhere: someWhere },
      );

      expect(mockDb.update).toHaveBeenCalled();
      expect(result).toEqual({
        kind: "redirect",
        authorizationUrl: "https://provider.example.com/authorize?x=1",
      });
    });

    it("reports alreadyAuthorized without clearing tokens when not forced", async () => {
      vi.mocked(mcpAuth).mockResolvedValueOnce("AUTHORIZED");

      const { authorizeMcpOAuth } = await import("./mcp-connection.ts");
      const result = await authorizeMcpOAuth(
        asDb(mockDb),
        { ...baseMcp, authType: "OAuth" },
        { force: false, clearTokensWhere: someWhere },
      );

      expect(mockDb.update).not.toHaveBeenCalled();
      expect(result).toEqual({ kind: "alreadyAuthorized" });
    });

    it("reports a 500 error when the SDK throws", async () => {
      vi.mocked(mcpAuth).mockRejectedValueOnce(new Error("network down"));

      const { authorizeMcpOAuth } = await import("./mcp-connection.ts");
      const result = await authorizeMcpOAuth(
        asDb(mockDb),
        { ...baseMcp, authType: "OAuth" },
        { force: false, clearTokensWhere: someWhere },
      );

      expect(result).toEqual({
        kind: "error",
        message: "network down",
        status: 500,
      });
    });
  });
});
