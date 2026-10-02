import {
  experimental_createMCPClient as createMCPClient,
  type ListToolsResult,
  type MCPClient,
  type MCPTransport,
} from "@ai-sdk/mcp";
import type { Tool, ToolExecutionOptions } from "ai";
import { TOOL_NAME_PATTERN, namespaceMcpToolName } from "@platypus/schemas";
import type { mcp as mcpTable } from "../db/schema.ts";
import { logger } from "../logger.ts";
import { CORE_BUILTIN_OWNER, getToolSetPlugin } from "../plugins/registry.ts";
import { buildMcpTransportConfig } from "../services/mcp-oauth-provider.ts";
import { normalizeToolResults } from "../services/tool-result.ts";
import {
  CallerAbortedError,
  DeadlineExceededError,
  withDeadline,
} from "../utils/abort-race.ts";
import { runCloser, type Closer, type CoreCloserRegistrar } from "./closers.ts";
import {
  getToolSet,
  reportToolNameCollisions,
  TOOL_SET_RESOLVE_TIMEOUT_MS,
  type CoreToolSetContext,
  type ToolOwner,
  type ToolSetContext,
} from "./index.ts";

type McpRow = typeof mcpTable.$inferSelect;

/**
 * How long after its last successful fetch an MCP's Last-known tool listing is
 * still served when a turn's fetch fails (ADR-0029). Not configurable: a day
 * covers restarts, deploys and overnight outages.
 */
export const LAST_KNOWN_LISTING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How stale an unchanged listing's fetched-at may get before a live fetch
 * rewrites it anyway — so a server whose tools never change keeps its day of
 * grace, for at most one write per MCP an hour.
 */
const LISTING_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * A client that never touches the network — a no-op transport and a canned
 * handshake — so a stored listing is turned into Tools by the library's own
 * `toolsFromDefinitions`, the conversion a live listing goes through. That is
 * what makes the two serialise byte-identical; its `execute` is never called.
 */
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

/**
 * Where the turn is running: the Workspace, the Organization, and the human it
 * is running for. Everything a delegate shares with the parent that spawned it,
 * which is why the Agent is not part of it — that is the one thing a nested
 * session changes.
 *
 * Declared as the SDK's `ToolSetContext` minus its `agentId` rather than as a
 * fresh list of fields, so a field added to the context reaches Tool-set
 * factories without a second edit here.
 *
 * `registerCloser` is omitted for a different reason than `agentId`, and the two
 * must not be collapsed into one idea: a scope is **data** the caller hands in
 * and shares with every delegate, while `registerCloser` is a **capability** each
 * session owns — a session's closers are its own, and a delegate's close with the
 * parent because the parent registered the child, not because they share a
 * registrar. Letting a scope carry one would mean a caller could pass a registrar
 * belonging to some other lifetime.
 */
export type ToolSessionScope = Omit<
  ToolSetContext,
  "agentId" | "registerCloser"
>;

/**
 * A registrar for a caller that must register a closer before the session it
 * belongs to exists.
 *
 * `prepareChatTurn` awaits the Tool session and a search backend's factory in the
 * *same* `Promise.all`, and that concurrency is load-bearing for first-token
 * latency — so the search path cannot be handed a session it would have to wait
 * for. It gets this instead, which defers onto the promise.
 *
 * Registration therefore lands a microtask after the Contribution's call, and
 * `prepareChatTurn` can now dispose the session before it returns — on the
 * failing path it opened for issue #630. Still safe, and no longer because
 * disposal is out of reach: this `then` is attached before that path's, so a
 * registration always wins the race, and one that somehow did not would be
 * closed on the spot by `registerCloser`'s already-disposed branch.
 */
export const deferCloserRegistrar =
  (session: Promise<ToolSession>): CoreCloserRegistrar =>
  (close, attribution) => {
    void session.then(
      (s) => s.registerCloser(close, attribution),
      // A session that never opened has nothing that will ever dispose it, so
      // the closer runs here rather than being dropped.
      () => runCloser(close, attribution),
    );
  };

/** An MCP's stored listing, if it was fetched less than a day ago. */
const usableLastKnownListing = (mcp: McpRow): ListToolsResult | null => {
  const fetchedAt = mcp.lastKnownToolListingFetchedAt;
  if (!mcp.lastKnownToolListing || !fetchedAt) return null;
  return Date.now() - fetchedAt.getTime() < LAST_KNOWN_LISTING_MAX_AGE_MS
    ? mcp.lastKnownToolListing
    : null;
};

/**
 * Whether an MCP fetch or connect failed because the server rejected its
 * credentials: `@ai-sdk/mcp`'s `UnauthorizedError` once an OAuth MCP's
 * refresh/authorize retry fails, or its `MCPClientError` with a 401/403 for a
 * Bearer or header MCP — anywhere in the `cause` chain. Matched by name, since
 * `MCPClientError` is not exported. Not a blip a reconnect recovers from, so no
 * Last-known listing is served for it.
 */
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

/** An open MCP connection and the once-only close registered for it. */
type OpenMcpClient = { client: MCPClient; close: () => Promise<void> };

/**
 * Tools built from a stored listing whose `execute` connects when the model
 * calls one: the call runs if the server is back, and fails as unreachable if
 * not. One connection, opened by the first call that finds the server up;
 * `open` registers it to close with the session like every other.
 *
 * The connect runs under the same deadline and run abort as a live fetch: a
 * server that takes the connection and never answers fails the call rather
 * than holding it until the step timer kills it (#1135).
 */
const lazyMcpTools = async (
  listing: ListToolsResult,
  open: () => Promise<OpenMcpClient>,
  mcpName: string,
  signal: AbortSignal | undefined,
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
      return client.toolsFromDefinitions(listing);
    } catch (error) {
      // Same as a live fetch's: a connect that outran the deadline is closed
      // when it finally lands, not held open to the end of the turn.
      void opening?.then(({ close }) => close()).catch(() => {});
      live = undefined;
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
          return (await live)[name].execute!(args, options) as unknown;
        },
      },
    ]),
  );
};

/** The Agent a session resolves Tool sets for — the parent, or one delegate. */
export type ToolSessionAgent = {
  id: string;
  toolSetIds?: readonly string[] | null;
};

/**
 * The MCP queries a session needs. Deliberately these rather than the Chat
 * turn's whole query surface: a session resolves tool sets, not a turn.
 * `ChatTurnQueries` extends it.
 */
export type ToolSessionQueries = {
  getMcp(
    id: string,
    orgId: string,
    workspaceId: string,
  ): Promise<McpRow | null>;
  /** Store an MCP's Last-known tool listing (ADR-0029). */
  saveMcpToolListing(
    id: string,
    listing: ListToolsResult,
    fetchedAt: Date,
  ): Promise<void>;
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
   * The names, among {@link tools}, whose MCP server declared `readOnlyHint`
   * (ADR-0021, issue #626) — keyed the same way `tools` is, by the name the
   * Tool enters this session under (post-namespacing, issue #467). Only the
   * MCP branch ever adds to this: a registered Tool set has nowhere to
   * declare the hint (out of scope for #626 — core Tool sets stay a literal
   * allowlist).
   *
   * Resolved per session and never persisted — it lives exactly as long as
   * `tools` does, and dies with this session the same way.
   */
  readOnlyToolNames: ReadonlySet<string>;
  /**
   * Open a session for another Agent — a delegate — under this session's scope,
   * whose connections close with this one's. Lifetime nests so a delegate never
   * hands its clients back to a caller to remember.
   */
  nest: (agent: ToolSessionAgent) => Promise<ToolSession>;
  /**
   * Hand this session something to close when it is disposed — the seam a Tool
   * set or a Web-search backend reaches through `ctx.registerCloser`, and the one
   * the MCP branch registers its own `client.close()` through.
   *
   * Deduped by identity, bounded by `CLOSER_TIMEOUT_MS`, and closed at once if
   * the session is already disposed.
   */
  registerCloser: CoreCloserRegistrar;
  /**
   * Close everything this session and its nested sessions opened. Idempotent, and
   * never throws: the caller runs it on abort and on finish alike.
   */
  dispose: () => Promise<void>;
};

/** What a session is opened under besides its scope. */
export type ToolSessionOptions = {
  /**
   * The run's abort. Resolving an id stops waiting the moment it fires, on top
   * of the {@link TOOL_SET_RESOLVE_TIMEOUT_MS} each id already resolves under
   * (issue #1135). A nested session inherits it: a delegate resolves while the
   * run that holds the parent session is still live.
   */
  signal?: AbortSignal;
};

/**
 * Resolve an Agent's assigned Tool sets into a turn's tools, opening whatever
 * connections that takes. A turn with no Agent (`undefined`) opens an empty
 * session, which is still a session — the caller disposes it the same way.
 *
 * Each assigned id is a registered Tool set or, failing that, an MCP server — the
 * two kinds an Agent's `toolSetIds` can name. Both fail soft: an id that resolves
 * to neither, a Tool set whose factory throws or outruns
 * {@link TOOL_SET_RESOLVE_TIMEOUT_MS}, an MCP server that is unreachable or
 * never answers — each costs its own tools and nothing else. A Chat turn is not the place to
 * discover that a plugin is broken (ADR-0013: strict at boot, forgiving at
 * runtime), and a Shared org-scoped MCP has org-wide blast radius (ADR-0007).
 */
export const openToolSession = async (
  scope: ToolSessionScope,
  agent: ToolSessionAgent | undefined,
  queries: ToolSessionQueries,
  options: ToolSessionOptions = {},
): Promise<ToolSession> => {
  const { signal } = options;
  const tools: Record<string, Tool> = {};
  // Tool name -> where it came from. Read by the merge below to report the
  // names an arriving Tool set is about to take, and the reason this is a Map
  // rather than the tool map alone.
  const owners = new Map<string, ToolOwner>();
  // Every name, among `tools`, whose MCP declared `readOnlyHint` (#626). Only
  // ever added to from the MCP case of `merge` below.
  const readOnlyToolNames = new Set<string>();
  const closers: Array<() => Promise<void>> = [];
  // Registered closers, by identity, and scoped to **this session** — so the
  // case it collapses is one turn reaching the same teardown twice, as two Tool
  // sets from one plugin sharing a client do. Across turns there is nothing to
  // dedupe against, by design: a later turn gets its own session, and a closer
  // it registers is its own to run.
  const registered = new Set<Closer>();
  let disposed = false;
  // MCP slug -> the MCP that already claimed it this turn (issue #467); see
  // the collision check in `merge` below for why this fails loudly.
  const usedMcpSlugs = new Map<string, McpRow>();

  const registerCloser: CoreCloserRegistrar = (close, attribution) => {
    // The TS type says `close` is a function; a third-party *JS* plugin can hand
    // over anything, and pushing a non-function would surface at teardown as a
    // TypeError inside `dispose` — far from the plugin that caused it. Same
    // posture as `asRecord` and the `typeof executors.web_search` guard.
    if (typeof close !== "function") {
      logger.warn(
        { ...attribution, received: typeof close },
        "Ignoring a closer that is not a function",
      );
      return;
    }
    if (registered.has(close)) return;
    registered.add(close);
    // Registered after teardown — a delegate resolving its Tool sets while an
    // abort unwinds the turn. Closed at once rather than pushed onto a list
    // nothing will read again; same reasoning as `nest`'s disposed branch below.
    if (disposed) {
      void runCloser(close, attribution);
      return;
    }
    closers.push(() => runCloser(close, attribution));
  };

  /**
   * Take `incoming`'s names for `owner`, reporting the ones taken from a Tool
   * set that claimed them earlier this turn.
   *
   * Reporting lives here rather than at each call site because a claim that
   * goes unreported is the bug issue #776 had to unpick: the check used to run
   * in two different places depending on the kind of Tool set, and only one of
   * them was at merge time.
   */
  const claim = (incoming: Record<string, Tool>, owner: ToolOwner): void => {
    reportToolNameCollisions(incoming, owners, owner);
    for (const [name, tool] of Object.entries(incoming)) {
      tools[name] = tool;
      owners.set(name, owner);
    }
  };

  /**
   * What resolving one assigned id produced, before any of it has touched the
   * turn. Carries its own fault rather than rejecting: a resolve runs beside
   * its siblings, and a rejection would settle the group while they are still
   * opening connections — clients the session would then never see to close.
   */
  type Resolution =
    | { kind: "none" }
    | { kind: "failed"; error: unknown }
    | { kind: "tools"; tools: Record<string, Tool>; owner: ToolOwner }
    | {
        kind: "mcp";
        mcp: McpRow;
        tools: Record<string, Tool>;
        owner: ToolOwner;
        readOnlyNames: readonly string[];
      };

  /**
   * Resolve one assigned id — a registered Tool set, or else an MCP server.
   *
   * Everything that touches the network or the database, and nothing else: this
   * reads none of the turn's shared state (`tools`, `owners`, `usedMcpSlugs`,
   * `readOnlyToolNames`) and mutates none of it, which is what lets every
   * assigned id resolve at once. `registerCloser` is the one exception, and
   * deliberately so — a connection is registered for closing the moment it
   * exists, so a server that opens beside one that fails is still torn down.
   */
  const resolve = async (
    toolSetId: string,
    context: CoreToolSetContext,
  ): Promise<Resolution> => {
    const registration = getToolSet(toolSetId);
    if (registration) {
      return {
        kind: "tools",
        tools: await registration.buildTurnTools(context, signal),
        owner: {
          toolSetId,
          // A Tool set belonging to no loaded plugin is a core registration, and
          // reads as one — the annotation the Tools catalog already uses. `null`
          // is reserved for the MCP branch, where there is genuinely no plugin.
          plugin: getToolSetPlugin(toolSetId) ?? CORE_BUILTIN_OWNER,
        },
      };
    }

    // Not a registered Tool set — the id names an MCP server, or nothing.
    const mcp = await queries.getMcp(toolSetId, scope.orgId, scope.workspaceId);
    if (!mcp) {
      logger.warn(
        `Tool set with id '${toolSetId}' not found as static tool set or MCP`,
      );
      return { kind: "none" };
    }
    if (!mcp.url) {
      logger.warn(`MCP '${toolSetId}' has no URL configured`);
      return { kind: "none" };
    }

    const attribution = {
      mcpId: mcp.id,
      scope: mcp.organizationId ? "org" : "ws",
    } as const;
    const openClient = async (): Promise<OpenMcpClient> => {
      const client = await createMCPClient({
        transport: buildMcpTransportConfig(mcp),
      });
      // Once only, so a connection closed early — abandoned by a fetch that
      // failed on it — is not closed a second time by dispose.
      let closing: Promise<void> | undefined;
      const close = () => (closing ??= client.close());
      // Registered the moment the connection exists, and before anything else
      // can fail on it — a server that connects and then fails to list its
      // tools used to leave the socket open for the life of the process. It is
      // also why the slug check now belongs to the merge and not here: a
      // connection this session can close is worth more than one never opened.
      registerCloser(close, attribution);
      return { client, close };
    };
    // Written by a live fetch when the listing changed or its fetched-at is due
    // a refresh, so most unchanged turns cost no write — and never at the
    // turn's expense: its own catch keeps a failed save from reaching the
    // fallback, since a listing that fails to save is a miss on some later
    // outage, not a reason to drop tools that just worked.
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

    // Split into the listing and the definitions-to-Tools conversion — still
    // one round trip, not two — so the raw `readOnlyHint` annotation (#626)
    // is in hand before it is discarded: `client.tools()` collapses both
    // steps and keeps only what it needs to resolve a display title, and the
    // hint is gone by the time it would return.
    //
    // Connect and list run under one deadline and the run's abort (issue
    // #1135): a server that takes the connection and never answers is a failed
    // fetch like any other, and falls back to the stored listing below rather
    // than holding the turn until the step timer kills it.
    let definitions: ListToolsResult;
    let mcpTools: Record<string, Tool>;
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
      await rememberListing(definitions);
    } catch (error) {
      // An abandoned connection is closed as soon as it exists — now, or when
      // a connect that outran the deadline finally lands — rather than held
      // open to the end of the turn: it served nothing, and a stale tool opens
      // its own if the model calls one. A close that fails is dispose's to
      // report: it gets the same promise, through `runCloser`.
      void opening?.then(({ close }) => close()).catch(() => {});
      // A cancelled turn will never read these tools, so it neither falls back
      // nor reports a server that may be perfectly healthy.
      if (error instanceof CallerAbortedError) return { kind: "none" };
      // Reconnecting cannot fix rejected credentials, so the stored listing
      // would only hand the model tools that fail until someone re-authorises.
      if (isMcpAuthFailure(error)) {
        logger.warn(
          { error, ...attribution },
          `MCP '${toolSetId}' rejected its credentials; it needs re-authorising — skipping its tools`,
        );
        return { kind: "none" };
      }
      const fault =
        error instanceof DeadlineExceededError
          ? `did not answer within ${TOOL_SET_RESOLVE_TIMEOUT_MS}ms`
          : "is unreachable";
      const listing = usableLastKnownListing(mcp);
      if (!listing) {
        logger.warn(
          { error, ...attribution },
          `MCP '${toolSetId}' ${fault}; skipping its tools`,
        );
        return { kind: "none" };
      }
      logger.warn(
        { error, ...attribution },
        `MCP '${toolSetId}' ${fault}; serving its last-known tool listing`,
      );
      definitions = listing;
      mcpTools = await lazyMcpTools(listing, openClient, mcp.name, signal);
    }

    // `true` only — the specification's own default for a missing hint, and
    // the tri-state this reduces to a boolean at: a string `"false"`, a `1`,
    // or any other non-boolean reads as undeclared exactly like an absent one
    // (ADR-0021), never coerced.
    const readOnlyHintByRawName = new Map<string, boolean>(
      definitions.tools.map((def) => [
        def.name,
        def.annotations?.readOnlyHint === true,
      ]),
    );

    // Every MCP-sourced tool enters the turn under `<slug>__<toolName>`,
    // unconditionally rather than only on collision, so a name never depends
    // on load order (issue #467). A server tool name that already looks
    // namespaced (e.g. `github__pull`) is prefixed anyway, not stripped:
    // stripping would guess at a third-party server's intent, and would
    // reintroduce this same bug for a server exposing both `pull` and
    // `github__pull`.
    const namespaced: Record<string, Tool> = {};
    const readOnlyNames: string[] = [];
    for (const [rawName, tool] of Object.entries(mcpTools)) {
      const namespacedName = namespaceMcpToolName(mcp.slug, rawName);
      if (!TOOL_NAME_PATTERN.test(namespacedName)) {
        // Never truncated or rewritten to fit: two long tool names from one
        // server could truncate onto each other and reintroduce the
        // collision invisibly. The MCP name is the User's own, so the report
        // points at the remedy — renaming the MCP shorter — rather than at
        // an internal id.
        logger.warn(
          { mcpId: mcp.id, mcpName: mcp.name, tool: rawName, namespacedName },
          "MCP tool name exceeds the model-provider name limit once namespaced; excluding it. Rename the MCP shorter to fix this.",
        );
        continue;
      }
      namespaced[namespacedName] = tool;
      // Keyed by the namespaced name — the name Tool-result clearing and the
      // rest of core will ever see this Tool under (#626) — so a Transcript
      // predating #467's namespacing degrades safely: an unrecognised name
      // reads as undeclared rather than being matched by accident.
      if (readOnlyHintByRawName.get(rawName)) {
        readOnlyNames.push(namespacedName);
      }
    }

    return {
      kind: "mcp",
      mcp,
      tools: normalizeToolResults(namespaced),
      owner: { toolSetId, plugin: null, mcpSlug: mcp.slug },
      readOnlyNames,
    };
  };

  /** {@link resolve}, with its own fault carried back rather than thrown. */
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

  /**
   * Fold one resolution into the turn. The only phase that touches the turn's
   * tool map, owner map, read-only names and claimed MCP slugs, and the only
   * one that reports a collision (through {@link claim}) — walked in
   * `toolSetIds` order, so the winner of a contested name and the warnings that
   * name it are what they always were, whichever resolve finished first.
   */
  const merge = (resolution: Resolution): void => {
    switch (resolution.kind) {
      case "none":
        return;
      // Rethrown here rather than where it was raised, so it reaches the caller
      // in assignment order and after every sibling has finished opening.
      case "failed":
        throw resolution.error;
      case "tools":
        claim(resolution.tools, resolution.owner);
        return;
      case "mcp": {
        // A turn-time backstop for two attached MCPs resolving to the same
        // tool-namespace slug (issue #467). The DB and the create/update routes
        // prevent this going forward, but a row created before this fix (or
        // backfilled with a collision the app-level check never saw) can still
        // reach here, and silently picking a winner would reintroduce the exact
        // shadowing this issue is about — just one level up, at the MCP rather
        // than the tool. So this fails the turn loudly instead of warning and
        // continuing, the way a plain tool-name collision does.
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
        }
        return;
      }
    }
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    for (const close of closers) {
      try {
        await close();
      } catch (e) {
        // Unreachable by construction: everything in `closers` is either a
        // `runCloser` wrapper, which catches and logs its own, or a nested
        // session's `dispose`, which is this function. Kept anyway, because
        // `dispose` never throwing is a contract the caller relies on while
        // unwinding an abort — and with its own message, so a future push that
        // breaks the invariant is not mistaken for a closer that simply failed.
        logger.error(
          { error: e },
          "A tool session closer threw past its own guard; dispose continuing",
        );
      }
    }
  };

  if (agent) {
    // What a Tool-set factory is handed: the turn's scope with this session's
    // Agent on it, so a parent's and a delegate's differ by exactly the Agent.
    // The registrar is this session's own — a delegate registers into itself and
    // the parent closes the delegate, so lifetime nests without a shared list.
    const context: CoreToolSetContext = {
      ...scope,
      agentId: agent.id,
      registerCloser,
    };
    // Concurrently: N MCP servers cost roughly the slowest open rather than the
    // sum of them, which is better than 99% of a turn's preparation once an
    // Agent attaches a few (issue #776). Nothing a Tool set *builds* ever
    // depended on what resolved before it — a factory is called
    // `tools(context, plugin)` and is never shown the accumulated map — so only
    // the merge below stays ordered.
    const resolutions = await Promise.all(
      (agent.toolSetIds ?? []).map((toolSetId) =>
        resolveSafely(toolSetId, context),
      ),
    );
    try {
      for (const resolution of resolutions) merge(resolution);
    } catch (error) {
      // The merge is the one phase that can fail the turn (two MCPs on one
      // slug), and it throws past the caller — which never receives the session
      // and so could never dispose it. Everything the resolve phase opened is
      // registered by now, so this is the only place it can be closed.
      await dispose();
      throw error;
    }
  }

  const nest: ToolSession["nest"] = async (nestedAgent) => {
    const child = await openToolSession(scope, nestedAgent, queries, options);
    // A delegate can be invoked while the turn is being torn down (an abort
    // cancels the parent run, and the delegate's generator is resumed to unwind
    // it), so a session opened after `dispose` has nothing left to attach to.
    // It is closed at once and serves no tools: handing back tools whose
    // connections are already shut would fail the delegate mid-call, where
    // having none simply leaves it without them.
    if (disposed) {
      await child.dispose();
      return { ...child, tools: {}, readOnlyToolNames: new Set() };
    }
    closers.push(child.dispose);
    return child;
  };

  return { tools, readOnlyToolNames, nest, registerCloser, dispose };
};
