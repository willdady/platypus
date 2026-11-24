import {
  createMCPClient,
  type ListToolsResult,
  type MCPClient,
  type MCPTransport,
} from "@ai-sdk/mcp";
import type { Tool, ToolExecutionOptions } from "ai";
import {
  TOOL_NAME_PATTERN,
  namespaceMcpToolName,
  type UnloadedToolSet,
} from "@platypus/schemas";
import type { mcp as mcpTable } from "../db/schema.ts";
import { logger } from "../logger.ts";
import { CORE_BUILTIN_OWNER, getToolSetPlugin } from "../plugins/registry.ts";
import { openMcpClient } from "../services/mcp-client.ts";
import { buildMcpTransportConfig } from "../services/mcp-oauth-provider.ts";
import { normalizeToolResults } from "../services/tool-result.ts";
import {
  CallerAbortedError,
  DeadlineExceededError,
  withDeadline,
} from "../utils/abort-race.ts";
import {
  guardedCloser,
  guardedSessionDispose,
  runCloser,
  type Closer,
  type CoreCloserRegistrar,
  type NonRejectingCloser,
} from "./closers.ts";
import type { ToolGateScope } from "../tool-gates/index.ts";
import {
  getToolSet,
  isSameSharedTool,
  reportToolNameCollisions,
  TOOL_SET_RESOLVE_TIMEOUT_MS,
  type CoreToolSetContext,
  type ToolOwner,
  type ToolSetContext,
} from "./index.ts";

type McpRow = typeof mcpTable.$inferSelect;

export const LAST_KNOWN_LISTING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const LISTING_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export const FETCH_FAILURE_SKIP_WINDOW_MS = 60_000;

const offlineMcpClient = (): Promise<MCPClient> => {
  const transport: MCPTransport = {
    start: () => Promise.resolve(),
    send: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return createMCPClient({
    transport,
    initialInitializeResult: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      serverInfo: { name: "", version: "" },
    },
  });
};

export type ToolSessionScope = Omit<
  ToolSetContext,
  "agentId" | "registerCloser"
>;

// why: chat-execution opens the session beside the search backend in one Promise.all
export const deferCloserRegistrar =
  (session: Promise<ToolSession>): CoreCloserRegistrar =>
  (close, attribution) => {
    void session.then(
      (s) => s.registerCloser(close, attribution),
      () => runCloser(close, attribution),
    );
  };

const usableLastKnownListing = (mcp: McpRow): ListToolsResult | null => {
  const fetchedAt = mcp.lastKnownToolListingFetchedAt;
  if (!mcp.lastKnownToolListing || !fetchedAt) return null;
  return Date.now() - fetchedAt.getTime() < LAST_KNOWN_LISTING_MAX_AGE_MS
    ? mcp.lastKnownToolListing
    : null;
};

const inSkipWindow = (mcp: McpRow): boolean =>
  !!mcp.lastFetchFailedAt &&
  Date.now() - mcp.lastFetchFailedAt.getTime() < FETCH_FAILURE_SKIP_WINDOW_MS;

const isMcpAuthFailure = (error: unknown): boolean => {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (e.name === "UnauthorizedError") return true;
    const { statusCode } = e as { statusCode?: unknown };
    if (
      e.name === "MCPClientError" &&
      (statusCode === 401 || statusCode === 403)
    )
      return true;
  }
  return false;
};

type OpenMcpClient = { client: MCPClient; close: () => Promise<void> };

const lazyMcpTools = async (
  listing: ListToolsResult,
  open: () => Promise<OpenMcpClient>,
  mcpName: string,
  signal: AbortSignal | undefined,
  onConnect: (ok: boolean, error?: unknown) => Promise<void>,
): Promise<Record<string, Tool>> => {
  let live: Promise<Record<string, Tool>> | undefined;
  const connectLive = async (): Promise<Record<string, Tool>> => {
    let opening: Promise<OpenMcpClient> | undefined;
    try {
      const { client } = await withDeadline(
        () => (opening = open()),
        TOOL_SET_RESOLVE_TIMEOUT_MS,
        signal,
      );
      await onConnect(true);
      return client.toolsFromDefinitions(listing);
    } catch (error) {
      void opening?.then(({ close }) => close()).catch(() => {});
      live = undefined;
      await onConnect(false, error);
      const fault = isMcpAuthFailure(error)
        ? "rejected its credentials; it needs re-authorising"
        : "is unreachable";
      throw new Error(`MCP server '${mcpName}' ${fault}`, { cause: error });
    }
  };
  const built = (await offlineMcpClient()).toolsFromDefinitions(listing);
  return Object.fromEntries(
    Object.entries(built).map(([name, tool]) => [
      name,
      {
        ...tool,
        execute: async (
          args: unknown,
          options: ToolExecutionOptions<unknown>,
        ) => {
          live ??= connectLive();
          const execute = (await live)[name]?.execute;
          if (!execute) {
            throw new Error(
              `MCP server '${mcpName}' no longer offers '${name}'`,
            );
          }
          return execute(args, options) as unknown;
        },
      },
    ]),
  );
};

export type ToolSessionAgent = {
  id: string;
  toolSetIds: readonly string[];
};

export type ToolSessionQueries = {
  getMcp(
    id: string,
    orgId: string,
    workspaceId: string,
  ): Promise<McpRow | null>;
  saveMcpToolListing(
    id: string,
    listing: ListToolsResult,
    fetchedAt: Date,
  ): Promise<void>;
  setMcpFetchFailedAt(id: string, failedAt: Date | null): Promise<void>;
};

export type ToolSession = {
  tools: Record<string, Tool>;
  readOnlyToolNames: ReadonlySet<string>;
  gateScope: ToolGateScope;
  unloadedToolSets: readonly UnloadedToolSet[];
  nest: (agent: ToolSessionAgent) => Promise<ToolSession>;
  registerCloser: CoreCloserRegistrar;
  dispose: () => Promise<void>;
};

export type ToolSessionOptions = {
  signal?: AbortSignal;
  withheldToolSetIds: readonly string[];
  interactive: boolean;
};

const DOWNLOAD_TOOL_NAME = "fsDownload";

export const openToolSession = async (
  scope: ToolSessionScope,
  agent: ToolSessionAgent | undefined,
  queries: ToolSessionQueries,
  options: ToolSessionOptions,
): Promise<ToolSession> => {
  const { signal, withheldToolSetIds, interactive } = options;
  const tools: Record<string, Tool> = {};
  const owners = new Map<string, ToolOwner>();
  const readOnlyToolNames = new Set<string>();
  const readOnlyHints = new Map<string, "read-only" | "writes">();
  const unloadedToolSets: UnloadedToolSet[] = [];
  const closers: NonRejectingCloser[] = [];
  const registered = new Set<Closer>();
  let disposed = false;
  const usedMcpSlugs = new Map<string, McpRow>();

  const registerCloser: CoreCloserRegistrar = (close, attribution) => {
    if (typeof close !== "function") {
      logger.warn(
        { ...attribution, received: typeof close },
        "Ignoring a closer that is not a function",
      );
      return;
    }
    if (registered.has(close)) return;
    registered.add(close);
    if (disposed) {
      void runCloser(close, attribution);
      return;
    }
    closers.push(guardedCloser(close, attribution));
  };

  const claim = (incoming: Record<string, Tool>, owner: ToolOwner): void => {
    const fresh = Object.fromEntries(
      Object.entries(incoming).filter(
        ([name, tool]) => !isSameSharedTool(tools[name], tool),
      ),
    );
    reportToolNameCollisions(fresh, owners, owner);
    for (const [name, tool] of Object.entries(fresh)) {
      tools[name] = tool;
      owners.set(name, owner);
    }
  };

  type Resolution =
    | { kind: "none"; unloaded?: UnloadedToolSet }
    | { kind: "failed"; error: unknown }
    | {
        kind: "tools";
        tools: Record<string, Tool>;
        owner: ToolOwner;
        unloaded?: UnloadedToolSet;
      }
    | {
        kind: "mcp";
        mcp: McpRow;
        tools: Record<string, Tool>;
        owner: ToolOwner;
        readOnlyNames: readonly string[];
        writeNames: readonly string[];
      };

  const resolve = async (
    toolSetId: string,
    context: CoreToolSetContext,
  ): Promise<Resolution> => {
    const registration = getToolSet(toolSetId);
    if (registration) {
      let factoryFailed = false;
      const built = await registration.buildTurnTools(context, signal, () => {
        factoryFailed = true;
      });
      return {
        kind: "tools",
        tools: built,
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set in a callback, which TS narrowing does not track
        ...(factoryFailed
          ? {
              unloaded: {
                toolSetId,
                name: registration.name,
                reason: "factory_failed" as const,
              },
            }
          : {}),
        owner: {
          toolSetId,
          plugin: getToolSetPlugin(toolSetId) ?? CORE_BUILTIN_OWNER,
        },
      };
    }

    const mcp = await queries.getMcp(toolSetId, scope.orgId, scope.workspaceId);
    if (!mcp) {
      logger.warn(
        `Tool set with id '${toolSetId}' not found as static tool set or MCP`,
      );
      return {
        kind: "none",
        unloaded: { toolSetId, name: null, reason: "not_found" },
      };
    }
    if (!mcp.url) {
      logger.warn(`MCP '${toolSetId}' has no URL configured`);
      return {
        kind: "none",
        unloaded: { toolSetId, name: mcp.name, reason: "misconfigured" },
      };
    }

    const attribution = {
      mcpId: mcp.id,
      scope: mcp.organizationId ? "org" : "ws",
    } as const;
    const openClient = async (): Promise<OpenMcpClient> => {
      const client = await openMcpClient(buildMcpTransportConfig(mcp));
      let closing: Promise<void> | undefined;
      const close = () => (closing ??= client.close());
      registerCloser(close, attribution);
      return { client, close };
    };
    const rememberListing = async (listing: ListToolsResult): Promise<void> => {
      const fetchedAt = mcp.lastKnownToolListingFetchedAt;
      if (
        JSON.stringify(listing) === JSON.stringify(mcp.lastKnownToolListing) &&
        fetchedAt &&
        Date.now() - fetchedAt.getTime() < LISTING_REFRESH_INTERVAL_MS
      ) {
        return;
      }
      try {
        await queries.saveMcpToolListing(mcp.id, listing, new Date());
      } catch (error) {
        logger.warn(
          { error, ...attribution },
          "Failed to store an MCP's last-known tool listing",
        );
      }
    };
    let failedAt = mcp.lastFetchFailedAt;
    const recordFetch = async (ok: boolean, error?: unknown): Promise<void> => {
      if (error instanceof CallerAbortedError) return;
      const next = ok || isMcpAuthFailure(error) ? null : new Date();
      if (!next && !failedAt) return;
      failedAt = next;
      try {
        await queries.setMcpFetchFailedAt(mcp.id, failedAt);
      } catch (writeError) {
        logger.warn(
          { error: writeError, ...attribution },
          "Failed to record an MCP's last fetch failure",
        );
      }
    };

    let definitions = inSkipWindow(mcp) ? usableLastKnownListing(mcp) : null;
    let mcpTools: Record<string, Tool> | undefined;
    if (definitions) {
      logger.warn(
        attribution,
        `MCP '${toolSetId}' failed its last fetch moments ago; serving its last-known tool listing without trying it`,
      );
    } else {
      let opening: ReturnType<typeof openClient> | undefined;
      try {
        const live = await withDeadline(
          async (deadline) => {
            opening = openClient();
            const { client } = await opening;
            const listed = await client.listTools({
              options: { signal: deadline },
            });
            return { listed, tools: client.toolsFromDefinitions(listed) };
          },
          TOOL_SET_RESOLVE_TIMEOUT_MS,
          signal,
        );
        definitions = live.listed;
        mcpTools = live.tools;
        await Promise.all([rememberListing(definitions), recordFetch(true)]);
      } catch (error) {
        void opening?.then(({ close }) => close()).catch(() => {});
        await recordFetch(false, error);
        if (error instanceof CallerAbortedError) return { kind: "none" };
        if (isMcpAuthFailure(error)) {
          logger.warn(
            { error, ...attribution },
            `MCP '${toolSetId}' rejected its credentials; it needs re-authorising — skipping its tools`,
          );
          return {
            kind: "none",
            unloaded: { toolSetId, name: mcp.name, reason: "unauthorized" },
          };
        }
        const fault =
          error instanceof DeadlineExceededError
            ? `did not answer within ${TOOL_SET_RESOLVE_TIMEOUT_MS}ms`
            : "is unreachable";
        definitions = usableLastKnownListing(mcp);
        if (!definitions) {
          logger.warn(
            { error, ...attribution },
            `MCP '${toolSetId}' ${fault}; skipping its tools`,
          );
          return {
            kind: "none",
            unloaded: { toolSetId, name: mcp.name, reason: "unreachable" },
          };
        }
        logger.warn(
          { error, ...attribution },
          `MCP '${toolSetId}' ${fault}; serving its last-known tool listing`,
        );
      }
    }
    mcpTools ??= await lazyMcpTools(
      definitions,
      openClient,
      mcp.name,
      signal,
      recordFetch,
    );

    const readOnlyHintByRawName = new Map<string, unknown>(
      definitions.tools.map((def) => [def.name, def.annotations?.readOnlyHint]),
    );

    const namespaced: Record<string, Tool> = {};
    const readOnlyNames: string[] = [];
    const writeNames: string[] = [];
    for (const [rawName, tool] of Object.entries(mcpTools)) {
      const namespacedName = namespaceMcpToolName(mcp.slug, rawName);
      if (!TOOL_NAME_PATTERN.test(namespacedName)) {
        logger.warn(
          { mcpId: mcp.id, mcpName: mcp.name, tool: rawName, namespacedName },
          "MCP tool name exceeds the model-provider name limit once namespaced; excluding it. Rename the MCP shorter to fix this.",
        );
        continue;
      }
      namespaced[namespacedName] = tool;
      const hint = readOnlyHintByRawName.get(rawName);
      if (hint === true) readOnlyNames.push(namespacedName);
      if (hint === false) writeNames.push(namespacedName);
    }

    return {
      kind: "mcp",
      mcp,
      tools: normalizeToolResults(namespaced),
      owner: { toolSetId, plugin: null, mcpSlug: mcp.slug },
      readOnlyNames,
      writeNames,
    };
  };

  const resolveSafely = async (
    toolSetId: string,
    context: CoreToolSetContext,
  ): Promise<Resolution> => {
    try {
      return await resolve(toolSetId, context);
    } catch (error) {
      return { kind: "failed", error };
    }
  };

  const merge = (resolution: Resolution): void => {
    switch (resolution.kind) {
      case "none":
        if (resolution.unloaded) unloadedToolSets.push(resolution.unloaded);
        return;
      case "failed":
        throw resolution.error;
      case "tools":
        if (resolution.unloaded) unloadedToolSets.push(resolution.unloaded);
        claim(resolution.tools, resolution.owner);
        return;
      case "mcp": {
        const incumbentMcp = usedMcpSlugs.get(resolution.mcp.slug);
        if (incumbentMcp) {
          throw new Error(
            `Two attached MCPs resolve to the same tool-namespace slug "${resolution.mcp.slug}": "${incumbentMcp.name}" (${incumbentMcp.id}) and "${resolution.mcp.name}" (${resolution.mcp.id}). Rename one of them.`,
          );
        }
        usedMcpSlugs.set(resolution.mcp.slug, resolution.mcp);
        claim(resolution.tools, resolution.owner);
        for (const name of resolution.readOnlyNames) {
          readOnlyToolNames.add(name);
          readOnlyHints.set(name, "read-only");
        }
        for (const name of resolution.writeNames) {
          readOnlyHints.set(name, "writes");
        }
        return;
      }
    }
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    for (const close of closers) await close();
  };

  if (agent) {
    const context: CoreToolSetContext = {
      ...scope,
      agentId: agent.id,
      registerCloser,
    };
    const resolutions = await Promise.all(
      agent.toolSetIds
        .filter((toolSetId) => !withheldToolSetIds.includes(toolSetId))
        .map((toolSetId) => resolveSafely(toolSetId, context)),
    );
    try {
      for (const resolution of resolutions) merge(resolution);
    } catch (error) {
      await dispose();
      throw error;
    }
    if (!interactive) delete tools[DOWNLOAD_TOOL_NAME];
  }

  const nest: ToolSession["nest"] = async (nestedAgent) => {
    const child = await openToolSession(scope, nestedAgent, queries, {
      ...options,
      interactive: false,
    });
    if (disposed) {
      await child.dispose();
      return {
        ...child,
        tools: {},
        readOnlyToolNames: new Set(),
        unloadedToolSets: [],
      };
    }
    closers.push(guardedSessionDispose(child));
    return child;
  };

  return {
    tools,
    readOnlyToolNames,
    gateScope: {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      ...(agent ? { agentId: agent.id } : {}),
      attended: interactive,
      toolSetIds: new Map(
        [...owners].map(([name, owner]) => [name, owner.toolSetId]),
      ),
      readOnlyHints,
    },
    unloadedToolSets,
    nest,
    registerCloser,
    dispose,
  };
};
