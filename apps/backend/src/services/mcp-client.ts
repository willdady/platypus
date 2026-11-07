import { createMCPClient, type MCPClientConfig } from "@ai-sdk/mcp";
import { checkEgress } from "../utils/egress-guard.ts";
import { env } from "../env.ts";
import { logger } from "../logger.ts";

/**
 * The one message every MCP URL refused by network policy reports, whatever
 * the reason — the reason itself goes to the server log.
 */
export const MCP_URL_BLOCKED_MESSAGE =
  "This MCP URL is not permitted by this deployment's network policy.";

/**
 * What `/test` reports for any failure to reach the server — refused, timed
 * out, unresolvable, TLS, or refused by network policy — so the probe cannot
 * map which internal hosts and ports exist. The detail goes to the server log.
 */
export const MCP_UNREACHABLE_MESSAGE =
  "Could not connect to the MCP server. Check its URL, and that this deployment's network policy permits it.";

/** Thrown by {@link openMcpClient} for a URL the egress guard refuses. */
export class McpEgressBlockedError extends Error {
  constructor() {
    super("MCP URL refused by network policy");
    this.name = "McpEgressBlockedError";
  }
}

/**
 * Whether the egress guard permits an MCP URL, logging the reason when not.
 * Loopback is refused unless the Operator sets `EGRESS_ALLOW_LOOPBACK_MCP` —
 * an MCP sidecar on the same host is a legitimate setup a model-supplied URL
 * never is.
 */
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

/**
 * Opens a client on a live MCP server with the legacy `initialize` handshake
 * every server speaks. The 2026-07-28 `server/discover` probe throws, rather
 * than falling back, when a server answers that it has modern serving disabled.
 *
 * The URL is checked first, every time: rows saved before MCP URLs were
 * guarded were never checked on save.
 */
export const openMcpClient = async (
  transport: MCPClientConfig["transport"] & { url: string },
) => {
  if (!(await mcpUrlPermitted(transport.url))) {
    throw new McpEgressBlockedError();
  }
  return createMCPClient({ transport, protocolVersionDiscovery: false });
};
