import { createMCPClient, type MCPClientConfig } from "@ai-sdk/mcp";
import { checkEgress } from "../utils/egress-guard.ts";
import { env } from "../env.ts";
import { logger } from "../logger.ts";

export const MCP_URL_BLOCKED_MESSAGE =
  "This MCP URL is not permitted by this deployment's network policy.";

export const MCP_UNREACHABLE_MESSAGE =
  "Could not connect to the MCP server. Check its URL, and that this deployment's network policy permits it.";

export class McpEgressBlockedError extends Error {
  constructor() {
    super("MCP URL refused by network policy");
    this.name = "McpEgressBlockedError";
  }
}

export const mcpUrlPermitted = async (
  url: string,
  mcpId?: string,
): Promise<boolean> => {
  const verdict = await checkEgress(url, {
    allowLoopback: env().EGRESS_ALLOW_LOOPBACK_MCP,
  });
  if (!verdict.allowed) {
    logger.warn(
      { mcpId, reason: verdict.reason },
      "Refused an MCP URL by network policy",
    );
  }
  return verdict.allowed;
};

export const openMcpClient = async (
  transport: MCPClientConfig["transport"] & { url: string },
) => {
  if (!(await mcpUrlPermitted(transport.url))) {
    throw new McpEgressBlockedError();
  }
  return createMCPClient({ transport, protocolVersionDiscovery: false });
};
