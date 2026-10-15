import {
  experimental_createMCPClient as createMCPClient,
  type MCPClientConfig,
} from "@ai-sdk/mcp";

/**
 * Opens a client on a live MCP server with the legacy `initialize` handshake
 * every server speaks. The 2026-07-28 `server/discover` probe throws, rather
 * than falling back, when a server answers that it has modern serving disabled.
 */
export const openMcpClient = (transport: MCPClientConfig["transport"]) =>
  createMCPClient({ transport, protocolVersionDiscovery: false });
