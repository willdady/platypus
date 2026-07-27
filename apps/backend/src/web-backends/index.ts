import { tool, type Tool } from "ai";
import type { PluginConfigContext } from "@platypuschat/plugin-sdk";
import { logger } from "../logger.ts";
import { checkEgress, EGRESS_BLOCKED_MESSAGE } from "../utils/egress-guard.ts";
import {
  readUrlInputSchema,
  webSearchInputSchema,
  type ReadUrlToolResult,
  type WebBackendContext,
  type WebBackendContribution,
  type WebBackendExecutors,
  type WebBackendRegistration,
  type WebSearchToolResult,
  type WebToolError,
} from "./types.ts";

// Output bounds for Web-search backends, fixed by Platypus and identical across
// every backend — the mirror of `sandbox/index.ts`'s MAX_* set (ADR-0002/0014).
// Backends never truncate: they return full results and core caps, so getting
// truncation wrong once cannot drop a multi-hundred-kilobyte response into the
// context window.
export const MAX_SEARCH_RESULTS = 10;
export const MAX_SNIPPET_CHARS = 500;
export const MAX_TITLE_CHARS = 200;
// How many raw entries core will look at to fill those 10 slots. The cap alone
// does not bound the work: entries with an unusable URL are dropped and skipped
// over, so an executor returning a million `javascript:` hits would otherwise
// have core parse a million URLs. Ten times the yield is ample slack for a
// backend whose upstream mixes in results core cannot present.
export const MAX_SEARCH_RESULT_SCAN = MAX_SEARCH_RESULTS * 10;
// `answer` is free text from an upstream answer box (Brave, Tavily), so it is
// capped like every other string a backend supplies. 10 results × 500 chars plus
// a 4k answer is ~9k characters worst case — comparable to native search output.
export const MAX_ANSWER_CHARS = 4_000;
// Mirrors sandbox MAX_READ_BYTES. Accepted limit, stated rather than implied: the
// executor hands core an already-materialised string, so this bounds *context and
// CPU*, not backend memory — a backend that buffers a 500 MB response does so
// before core sees it, and the per-call timeout is the only lever there.
export const MAX_READ_URL_CONTENT_CHARS = 1_000_000;

// Per-call executor timeouts. The default applies when a contribution omits
// `timeoutMs`; the ceiling is refused at boot by the plugin loader (fail-loud,
// plugin-named) rather than silently clamped here, because `timeoutMs` is static
// on the contribution and therefore knowable at load. 120s covers a cold
// headless-browser render with headroom.
export const DEFAULT_WEB_TIMEOUT_MS = 30_000;
export const MAX_WEB_TIMEOUT_MS = 120_000;

const WEB_SEARCH_DESCRIPTION =
  "Search the web for current information. Returns a list of results with titles, URLs and snippets, and sometimes a direct answer.";

const READ_URL_DESCRIPTION =
  "Read the contents of a web page as text. Supports pagination for large pages via start_index.";

// The registry, mirroring `sandbox/index.ts`: a flat map keyed by the
// discriminator stored in `provider.webBackend`.
const WEB_BACKEND_REGISTRY: Record<string, WebBackendRegistration> = {};

export const registerWebBackend = (
  registration: WebBackendRegistration,
): void => {
  if (registration.backend in WEB_BACKEND_REGISTRY) {
    throw new Error(
      `Web backend '${registration.backend}' has already been registered.`,
    );
  }
  WEB_BACKEND_REGISTRY[registration.backend] = registration;
};

export const getWebBackend = (
  backend: string,
): WebBackendRegistration | undefined => WEB_BACKEND_REGISTRY[backend];

export const getWebBackends = (): ReadonlyArray<WebBackendRegistration> =>
  Object.values(WEB_BACKEND_REGISTRY);

/** Test-only reset. Boot registers once; nothing in production unregisters. */
export const clearWebBackends = (): void => {
  for (const key of Object.keys(WEB_BACKEND_REGISTRY)) {
    delete WEB_BACKEND_REGISTRY[key];
  }
};

// Cut a backend-supplied string to a core-owned bound, marking the cut so the
// model can tell a truncated snippet from a naturally short one.
const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}…` : value;

// Everything an executor resolves is read through this, so the wrapper treats a
// backend's payload as `unknown` and narrows field by field. The SDK types say
// what a well-behaved backend returns; a third-party JS plugin is under no
// obligation to honour them, and core must not fall over on the difference.
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

/**
 * Whether a URL may be presented to the model (and, in the frontend, rendered as
 * a clickable Sources pill). The egress guard covers **model-supplied** URLs going
 * *into* `read_url`; this covers **backend-supplied** URLs coming *out* of
 * `web_search`, which nothing else checks — a `javascript:` or `data:` href in a
 * pill is a live hole, and dropping the entry also keeps garbage out of the
 * context window.
 */
export const isPresentableUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

/** Raised when an executor outruns its per-call timeout. */
class WebBackendTimeoutError extends Error {}

/**
 * Race an executor against its timeout.
 *
 * The loser is not cancelled: the v1 executor contract carries no `AbortSignal`,
 * so a hung upstream call keeps running in the background until its own socket
 * timeout. What the timeout guarantees is that the *turn* is not pinned open —
 * which is the property the ceiling exists to protect.
 */
const withTimeout = async <T>(
  run: () => Promise<T> | T,
  timeoutMs: number,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(run()),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new WebBackendTimeoutError(
                `executor timed out after ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

// The model-facing failure text. Deliberately fixed rather than the upstream
// cause: a backend's error message routinely embeds the URL it called, which for
// a hosted search API carries the Operator's API key as a query parameter. The
// cause goes to the log line instead.
const timeoutMessage = (toolName: string, timeoutMs: number): string =>
  `The web backend did not respond within ${timeoutMs}ms (${toolName}).`;

const failureMessage = (toolName: string): string =>
  `The web backend could not complete this ${toolName} request.`;

export interface ComposeWebBackendOptions {
  /**
   * The contribution exactly as its author wrote it. Passed through untouched —
   * never spread into a copy — so `createExecutors` is invoked with the author's
   * own object as its receiver and a class-instance contribution keeps both its
   * prototype methods and its `this`. The namespaced id rides {@link backend}
   * instead, which is why this stays the original reference.
   */
  contribution: WebBackendContribution;
  /**
   * The loader's namespaced discriminator, overriding `contribution.backend`.
   * Omitted outside the loader (tests, core registrations), where the
   * contribution's own bare id is already the effective one.
   */
  backend?: string;
  /** The plugin's boot-resolved deploy-time config/credentials (ADR-0013). */
  plugin?: PluginConfigContext;
  /** Owning plugin's manifest name, for attribution in every log line. */
  pluginName: string;
  /**
   * Hostname resolver handed to the egress guard. Injected by tests so the guard
   * itself stays in the path; production uses its DNS default.
   */
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

/**
 * Wrap one Web-search-backend contribution into the registration core stores.
 *
 * This is where core takes ownership of everything except the upstream call
 * itself (ADR-0014): fixed input schemas and descriptions, result-count caps and
 * string truncation, `read_url` content capping plus `max_length` / `start_index`
 * slicing with a `next_start_index` continuation hint, the egress guard on the
 * model-supplied URL, the per-call timeout, the throw→error-string contract, and
 * one observability line per executor call.
 */
export const composeWebBackend = (
  options: ComposeWebBackendOptions,
): WebBackendRegistration => {
  const { contribution, plugin, pluginName, resolveHostname } = options;
  const backend = options.backend ?? contribution.backend;
  const timeoutMs = contribution.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;

  // One line per executor call (ADR-0014 observability). `debug` when it worked,
  // `warn` when it did not, cause attached on failure. Queries and URLs are user
  // content and can carry sensitive terms, so they never reach *this* line; the
  // model's query appears only on the `debug` line below. A model-supplied URL
  // does reach `warn` on the two paths that cannot be diagnosed without it — an
  // egress block and a content-cap hit — which is what D3 and the egress-guard
  // contract call for.
  const logCall = (
    toolName: string,
    outcome: "ok" | "timeout" | "blocked" | "error",
    startedAt: number,
    cause?: unknown,
  ): void => {
    const line = {
      backend,
      plugin: pluginName,
      tool: toolName,
      durationMs: Date.now() - startedAt,
      outcome,
    };
    if (outcome === "ok") {
      logger.debug(line, "Web backend executor call");
    } else {
      logger.warn({ ...line, cause }, "Web backend executor call failed");
    }
  };

  const buildSearchTool = (
    webSearch: WebBackendExecutors["web_search"],
  ): Tool =>
    tool({
      description: WEB_SEARCH_DESCRIPTION,
      inputSchema: webSearchInputSchema,
      execute: async ({
        query,
      }): Promise<WebSearchToolResult | WebToolError> => {
        const startedAt = Date.now();
        logger.debug(
          { backend, plugin: pluginName, query },
          "web_search query",
        );

        let raw: unknown;
        try {
          raw = await withTimeout(() => webSearch({ query }), timeoutMs);
        } catch (cause) {
          const timedOut = cause instanceof WebBackendTimeoutError;
          logCall(
            "web_search",
            timedOut ? "timeout" : "error",
            startedAt,
            cause,
          );
          return {
            error: timedOut
              ? timeoutMessage("web_search", timeoutMs)
              : failureMessage("web_search"),
          };
        }

        const payload = asRecord(raw);
        const entries: readonly unknown[] = Array.isArray(payload.results)
          ? payload.results
          : [];

        const results: WebSearchToolResult["results"] = [];
        let dropped = 0;
        // Bounded on both ends: `MAX_SEARCH_RESULTS` on what is kept, and
        // `MAX_SEARCH_RESULT_SCAN` on what is even looked at, so a pathological
        // result array cannot spend core's CPU parsing URLs it will discard.
        const scanned = entries.slice(0, MAX_SEARCH_RESULT_SCAN);
        for (const candidate of scanned) {
          if (results.length >= MAX_SEARCH_RESULTS) break;
          const entry = asRecord(candidate);
          if (!isPresentableUrl(entry.url)) {
            dropped += 1;
            continue;
          }
          const hit: WebSearchToolResult["results"][number] = {
            title: truncate(
              typeof entry.title === "string" ? entry.title : "",
              MAX_TITLE_CHARS,
            ),
            url: entry.url,
          };
          if (typeof entry.snippet === "string") {
            hit.snippet = truncate(entry.snippet, MAX_SNIPPET_CHARS);
          }
          results.push(hit);
        }
        if (dropped > 0) {
          logger.warn(
            { backend, plugin: pluginName, dropped },
            "Dropped web_search results whose URL was not http(s)",
          );
        }
        if (entries.length > scanned.length) {
          logger.warn(
            {
              backend,
              plugin: pluginName,
              returned: entries.length,
              scanned: scanned.length,
            },
            "Web backend returned more results than core will scan; the tail was ignored",
          );
        }

        // `query` is echoed from the model's own input, never from the executor:
        // core owns this shape, so a backend cannot substitute text here.
        const result: WebSearchToolResult = { query, results };
        if (typeof payload.answer === "string") {
          result.answer = truncate(payload.answer, MAX_ANSWER_CHARS);
        }

        logCall("web_search", "ok", startedAt);
        return result;
      },
    });

  const buildReadUrlTool = (
    readUrl: NonNullable<WebBackendExecutors["read_url"]>,
  ): Tool =>
    tool({
      description: READ_URL_DESCRIPTION,
      inputSchema: readUrlInputSchema,
      execute: async ({
        url,
        max_length,
        start_index,
      }): Promise<ReadUrlToolResult | WebToolError> => {
        const startedAt = Date.now();
        logger.debug({ backend, plugin: pluginName, url }, "read_url target");

        // The URL comes from the model, so it is vetted before anything reaches
        // the network — the whole reason core, not the backend, owns this Tool.
        const egress = await checkEgress(url, { resolve: resolveHostname });
        if (!egress.allowed) {
          logger.warn(
            { tool: "read_url", backend, url, reason: egress.reason },
            "Blocked a model-supplied URL by network policy",
          );
          logCall("read_url", "blocked", startedAt);
          return { error: EGRESS_BLOCKED_MESSAGE };
        }

        let raw: unknown;
        try {
          raw = await withTimeout(() => readUrl({ url }), timeoutMs);
        } catch (cause) {
          const timedOut = cause instanceof WebBackendTimeoutError;
          logCall("read_url", timedOut ? "timeout" : "error", startedAt, cause);
          return {
            error: timedOut
              ? timeoutMessage("read_url", timeoutMs)
              : failureMessage("read_url"),
          };
        }

        // Cap first, then slice within the capped string: the cap bounds what core
        // ever holds, the slice serves this page of it.
        const payload = asRecord(raw);
        const full = typeof payload.content === "string" ? payload.content : "";
        const capped = full.length > MAX_READ_URL_CONTENT_CHARS;
        if (capped) {
          logger.warn(
            { backend, url, length: full.length },
            "Web backend read_url content exceeded the core cap and was truncated",
          );
        }
        const content = capped
          ? full.slice(0, MAX_READ_URL_CONTENT_CHARS)
          : full;

        const slice = content.slice(start_index, start_index + max_length);
        const hasMore = start_index + max_length < content.length;
        const next_start_index = start_index + max_length;

        // Same hint text as `fetchUrl`, so a continuation read reads identically
        // whichever page-reader the model reached for. At the tail of a capped
        // page there is nothing to continue *to*, and `truncated: true` with no
        // `next_start_index` would read as an unexplained dead end — so the cut
        // is spelled out instead of left for the model to infer.
        let body = slice;
        if (hasMore) {
          body += `\n\n[Content truncated. Pass start_index=${next_start_index} to continue reading.]`;
        } else if (capped) {
          body += `\n\n[Content truncated: the page exceeded the ${MAX_READ_URL_CONTENT_CHARS}-character limit and the remainder cannot be read.]`;
        }

        const result: ReadUrlToolResult = {
          content: body,
          url: isPresentableUrl(payload.url) ? payload.url : url,
          content_type:
            typeof payload.contentType === "string" ? payload.contentType : "",
          // True when *anything* was cut — the core cap or this slice.
          truncated: hasMore || capped,
        };
        if (hasMore) {
          result.next_start_index = next_start_index;
        }

        logCall("read_url", "ok", startedAt);
        return result;
      },
    });

  return {
    backend,
    name: contribution.name,
    buildTurnTools: async (ctx: WebBackendContext) => {
      const executors = await contribution.createExecutors(ctx, plugin);

      // The TS type makes `web_search` required, but a third-party JS plugin can
      // return anything. Boot stays fail-loud (the loader rejects a missing
      // `createExecutors`); runtime resolution stays graceful, so a malformed
      // executor object costs the turn its search tools, not the turn.
      if (typeof executors?.web_search !== "function") {
        logger.warn(
          { plugin: pluginName, backend },
          "Web backend returned no web_search executor; serving no search tools this turn",
        );
        return {};
      }

      // Both executors are bound to the object that supplied them, so a backend
      // may write them as methods reaching sibling state through `this`.
      const tools: Record<string, Tool> = {
        web_search: buildSearchTool(executors.web_search.bind(executors)),
      };
      if (typeof executors.read_url === "function") {
        tools.read_url = buildReadUrlTool(executors.read_url.bind(executors));
      }
      return tools;
    },
  };
};

export * from "./types.ts";
