import {
  experimental_createMCPClient as createMCPClient,
  type MCPClient,
} from "@ai-sdk/mcp";
import type { Tool } from "ai";
import type { mcp as mcpTable } from "../db/schema.ts";
import { logger } from "../logger.ts";
import { CORE_BUILTIN_OWNER, getToolSetPlugin } from "../plugins/registry.ts";
import { buildMcpTransportConfig } from "../services/mcp-oauth-provider.ts";
import { normalizeToolResults } from "../services/tool-result.ts";
import {
  getToolSet,
  reportToolNameCollisions,
  type ToolOwner,
  type ToolSetContext,
} from "./index.ts";

type McpRow = typeof mcpTable.$inferSelect;

/**
 * Where the turn is running: the Workspace, the Organization, and the human it
 * is running for. Everything a delegate shares with the parent that spawned it,
 * which is why the Agent is not part of it — that is the one thing a nested
 * session changes.
 *
 * Declared as the SDK's `ToolSetContext` minus its `agentId` rather than as a
 * fresh list of fields, so a field added to the context reaches Tool-set
 * factories without a second edit here.
 */
export type ToolSessionScope = Omit<ToolSetContext, "agentId">;

/** The Agent a session resolves Tool sets for — the parent, or one delegate. */
export type ToolSessionAgent = {
  id: string;
  toolSetIds?: readonly string[] | null;
};

/**
 * The MCP lookup a session needs. Deliberately the one method rather than the
 * Chat turn's whole query surface: a session resolves tool sets, not a turn.
 * `ChatTurnQueries` satisfies it structurally.
 */
export type ToolSessionQueries = {
  getMcp(
    id: string,
    orgId: string,
    workspaceId: string,
  ): Promise<McpRow | null>;
};

/**
 * The tools an Agent's assigned Tool sets serve for one turn, and the connections
 * opened to serve them.
 *
 * A session, not a tool map plus a client array, because those two are one fact:
 * the turn used to decide what it had opened in three places — `loadTools`
 * returned clients, the sub-agent loader accumulated a second list by mutating a
 * captured array, and `prepareChatTurn` merged both and hand-rolled the teardown.
 * A third tool source would have leaked its connections silently. Here whatever
 * opens a connection registers its own close, and a caller sees one `dispose`.
 */
export type ToolSession = {
  /** The Tools this session's Tool sets contributed, keyed by tool name. */
  tools: Record<string, Tool>;
  /**
   * Open a session for another Agent — a delegate — under this session's scope,
   * whose connections close with this one's. Lifetime nests so a delegate never
   * hands its clients back to a caller to remember.
   */
  nest: (agent: ToolSessionAgent) => Promise<ToolSession>;
  /**
   * Close everything this session and its nested sessions opened. Idempotent, and
   * never throws: the caller runs it on abort and on finish alike.
   */
  dispose: () => Promise<void>;
};

/**
 * Resolve an Agent's assigned Tool sets into a turn's tools, opening whatever
 * connections that takes. A turn with no Agent (`undefined`) opens an empty
 * session, which is still a session — the caller disposes it the same way.
 *
 * Each assigned id is a registered Tool set or, failing that, an MCP server — the
 * two kinds an Agent's `toolSetIds` can name. Both fail soft: an id that resolves
 * to neither, a Tool set whose factory throws, an MCP server that is unreachable
 * — each costs its own tools and nothing else. A Chat turn is not the place to
 * discover that a plugin is broken (ADR-0013: strict at boot, forgiving at
 * runtime), and a Shared org-scoped MCP has org-wide blast radius (ADR-0007).
 */
export const openToolSession = async (
  scope: ToolSessionScope,
  agent: ToolSessionAgent | undefined,
  queries: ToolSessionQueries,
): Promise<ToolSession> => {
  const tools: Record<string, Tool> = {};
  // Tool name -> where it came from. Handed to each Tool set as it resolves so
  // it can report the names it is about to take, and the reason this is a Map
  // rather than the tool map alone.
  const owners = new Map<string, ToolOwner>();
  const closers: Array<() => Promise<void>> = [];

  const claim = (incoming: Record<string, Tool>, owner: ToolOwner): void => {
    for (const [name, tool] of Object.entries(incoming)) {
      tools[name] = tool;
      owners.set(name, owner);
    }
  };

  /** Resolve one assigned id — a registered Tool set, or else an MCP server. */
  const open = async (
    toolSetId: string,
    context: ToolSetContext,
  ): Promise<void> => {
    const registration = getToolSet(toolSetId);
    if (registration) {
      const turnTools = await registration.buildTurnTools(context, owners);
      claim(turnTools, {
        toolSetId,
        // A Tool set belonging to no loaded plugin is a core registration, and
        // reads as one — the annotation the Tools catalog already uses. `null`
        // is reserved for the MCP branch, where there is genuinely no plugin.
        plugin: getToolSetPlugin(toolSetId) ?? CORE_BUILTIN_OWNER,
      });
      return;
    }

    // Not a registered Tool set — the id names an MCP server, or nothing.
    const mcp = await queries.getMcp(toolSetId, scope.orgId, scope.workspaceId);
    if (!mcp) {
      logger.warn(
        `Tool set with id '${toolSetId}' not found as static tool set or MCP`,
      );
      return;
    }
    if (!mcp.url) {
      logger.warn(`MCP '${toolSetId}' has no URL configured`);
      return;
    }

    const warnUnreachable = (error: unknown) => {
      logger.warn(
        { error, mcpId: mcp.id, scope: mcp.organizationId ? "org" : "ws" },
        `MCP '${toolSetId}' is unreachable; skipping its tools`,
      );
    };

    let client: MCPClient;
    try {
      client = await createMCPClient({
        transport: buildMcpTransportConfig(mcp),
      });
    } catch (error) {
      warnUnreachable(error);
      return;
    }

    // Registered the moment the connection exists, and before anything else can
    // fail on it — a server that connects and then fails to list its tools used
    // to leave the socket open for the life of the process.
    closers.push(() => client.close());

    let mcpTools: Record<string, Tool>;
    try {
      mcpTools = await client.tools();
    } catch (error) {
      warnUnreachable(error);
      return;
    }

    const owner: ToolOwner = { toolSetId, plugin: null };
    const normalized = normalizeToolResults(mcpTools);
    reportToolNameCollisions(normalized, owners, owner);
    claim(normalized, owner);
  };

  if (agent) {
    // What a Tool-set factory is handed: the turn's scope with this session's
    // Agent on it, so a parent's and a delegate's differ by exactly the Agent.
    const context: ToolSetContext = { ...scope, agentId: agent.id };
    // Sequentially: each Tool set is shown the names the ones before it claimed.
    for (const toolSetId of agent.toolSetIds ?? []) {
      await open(toolSetId, context);
    }
  }

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    for (const close of closers) {
      try {
        await close();
      } catch (e) {
        logger.error({ error: e }, "Error closing a tool session's connection");
      }
    }
  };

  const nest: ToolSession["nest"] = async (nestedAgent) => {
    const child = await openToolSession(scope, nestedAgent, queries);
    // A delegate can be invoked while the turn is being torn down (an abort
    // cancels the parent run, and the delegate's generator is resumed to unwind
    // it), so a session opened after `dispose` has nothing left to attach to.
    // It is closed at once and serves no tools: handing back tools whose
    // connections are already shut would fail the delegate mid-call, where
    // having none simply leaves it without them.
    if (disposed) {
      await child.dispose();
      return { ...child, tools: {} };
    }
    closers.push(child.dispose);
    return child;
  };

  return { tools, nest, dispose };
};
