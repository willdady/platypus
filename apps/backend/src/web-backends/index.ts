import { tool, type Tool } from "ai";
import type { PluginConfigContext } from "@platypuschat/plugin-sdk";
import { isPresentableUrl, WEB_BACKEND_TOOL_MARKER } from "@platypus/schemas";
import { logger } from "../logger.ts";
import { createContributionRegistry } from "../registry/contribution-registry.ts";
import { checkEgress, EGRESS_BLOCKED_MESSAGE } from "../utils/egress-guard.ts";
import { withAttributedRegistrar } from "../tools/closers.ts";
import {
  MAX_READ_URL_CONTENT_CHARS,
  MAX_READ_URL_SLICE_CHARS,
  MAX_URL_CHARS,
  readUrlInputSchema,
  webSearchInputSchema,
  type ReadUrlToolResult,
  type WebBackendContext,
  type TurnToolsContext,
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
// `content_type` is metadata, not a link, so it is shortened rather than dropped —
// but sliced bare, without `truncate`'s `…` marker: the marker suits prose a model
// reads, where a machine-readable MIME type carrying one is invalid rather than
// honestly-shortened.
export const MAX_CONTENT_TYPE_CHARS = 200;
// `MAX_URL_CHARS` and `MAX_READ_URL_CONTENT_CHARS` live in `./types.ts` — the input
// schemas there reference them — and are re-exported from this module by the
// `export *` at the bottom, so they read as part of this MAX_* set either way.

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

// Stamped on both Tools core builds. Not sent to the model — the AI SDK carries a
// Tool's `metadata` onto the tool call's `toolMetadata`, onto the UI message part,
// and so into the stored message — which is how the frontend tells a plugin
// `web_search` from a Provider's own, since the two share a tool name. See
// `WEB_BACKEND_TOOL_MARKER`.
const WEB_BACKEND_TOOL_METADATA = { [WEB_BACKEND_TOOL_MARKER]: true };

// The Web-search-backend instance of the shared Extension-point registry, keyed
// by the discriminator stored in `provider.searchSource`.
const WEB_BACKENDS = createContributionRegistry<WebBackendRegistration>({
  noun: "Web backend",
});

export const registerWebBackend = (
  registration: WebBackendRegistration,
): void => {
  WEB_BACKENDS.register(registration.backend, registration);
};

/** The backend registered under `backend`, or `undefined` if none is. */
export const getWebBackend = (
  backend: string,
): WebBackendRegistration | undefined => WEB_BACKENDS.get(backend);

/** Every registered Web-search backend, in registration order. */
export const getWebBackends = (): ReadonlyArray<WebBackendRegistration> =>
  WEB_BACKENDS.list();

/** Test-only reset — see {@link createContributionRegistry}. */
export const clearWebBackends = (): void => WEB_BACKENDS.clear();

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

// `isPresentableUrl` — the scheme filter every backend-supplied URL passes before
// it reaches the model — lives in `@platypus/schemas` (imported above), not here.
// It moved when the frontend became its second consumer: the Sources row renders
// those URLs as `href`s and re-checks with this exact predicate before anything
// reaches the DOM. One consumer did not justify the shared-package indirection;
// two consumers of a *security* check, one of them the one that decides what
// becomes a link, do. Its cases are covered in that package's tests.

/**
 * The `url` a `read_url` result reports, bounded by `MAX_URL_CHARS` on every
 * branch. The backend's resolved (post-redirect) URL is preferred — it is what a
 * citation should point at — and falls back to the URL the model asked for.
 *
 * Three branches rather than two because `readUrlInputSchema.url` is uncapped,
 * so the request is not itself a bounded fallback: a presigned S3 or Azure SAS
 * link can legitimately run past `MAX_URL_CHARS`, and core reads it instead of
 * failing schema validation. When neither URL fits, the request's origin is the
 * longest prefix that is still a working link — a citation to the host beats a
 * URL cut mid-query-string, which is a broken link (the same drop-not-truncate
 * reasoning as a search result URL, D5).
 *
 * Length is checked before scheme for the search loop's reason: `isPresentableUrl`
 * parses the whole string, and a URL about to be rejected for length should not
 * be parsed first.
 */
const presentableReadUrl = (resolved: unknown, requested: string): string => {
  if (
    typeof resolved === "string" &&
    resolved.length <= MAX_URL_CHARS &&
    isPresentableUrl(resolved)
  ) {
    return resolved;
  }
  if (requested.length <= MAX_URL_CHARS) return requested;
  // Unreachable in practice: `requested` cleared `z.string().url()` and the
  // egress guard, so it parses and is http(s). Guarded anyway — this runs on the
  // success path of a tool whose whole contract is to return `{ error }` rather
  // than throw.
  try {
    return new URL(requested).origin;
  } catch {
    return "";
  }
};

/** Raised when an executor outruns its per-call timeout. */
class WebBackendTimeoutError extends Error {}

/** Raised when the turn the executor was called for was cancelled under it. */
class WebBackendCancelledError extends Error {}

/**
 * Reject as soon as `signal` aborts, and hand back the means to drop the listener.
 *
 * Released in a `finally` rather than left to garbage collection. The signal
 * listened on is per-call, but it is *derived from* the run's, which outlives
 * every individual tool call — and the shape of that retention is the platform's
 * business, not something a searching turn should depend on being generous.
 */
const rejectOnAbort = (
  signal: AbortSignal,
): { promise: Promise<never>; release: () => void } => {
  let release = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    // The signal's own `reason` is `any` — a caller may abort with anything — and
    // it is never read: `withDeadline` classifies on *which* signal aborted, not
    // on what it was aborted with. Carried as `cause` so nothing is lost.
    const onAbort = () =>
      reject(new Error("aborted", { cause: signal.reason }));
    // Not the live path: `withDeadline` refuses an already-aborted call before it
    // gets here, precisely so this promise is never handed back already rejected
    // with nothing attached to it. The branch stays as the guard that keeps that
    // true for a second caller.
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    release = () => signal.removeEventListener("abort", onAbort);
  });
  return { promise, release };
};

/**
 * Run an executor under a deadline, and hand it the signal for that deadline.
 *
 * Two things at once, because they are one signal to whoever is called: the
 * per-call `timeoutMs`, and the caller's own — a User cancelling the turn. A
 * backend that honours it stops its upstream request for either reason.
 *
 * Still a **race**, not a bare signal: honouring the signal is optional (it is an
 * appended parameter on a v1 contract), so an executor that ignores it must
 * remain bounded. That the *turn* is not pinned open is the property the ceiling
 * exists to protect, and it cannot rest on a Contribution's cooperation.
 *
 * Which signal aborted decides what the caller sees. The deadline is inspected
 * first so that a call which had already outrun its budget is reported as a
 * timeout even if the run was cancelled in the same instant — the deadline is the
 * older of the two facts, and the one an Operator can act on.
 */
const withDeadline = async <T>(
  run: (signal: AbortSignal) => Promise<T> | T,
  timeoutMs: number,
  caller?: AbortSignal,
): Promise<T> => {
  // A cleared timer rather than `AbortSignal.timeout`: the signal that helper
  // returns cannot be released, so every *successful* call would leave a timer
  // alive for the rest of its budget — 120s at the ceiling — to abort a signal
  // nobody is listening to. Tool calls are the hottest path a backend has.
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new WebBackendTimeoutError(`executor timed out after ${timeoutMs}ms`),
      ),
    timeoutMs,
  );
  const signal = caller
    ? AbortSignal.any([deadline.signal, caller])
    : deadline.signal;
  try {
    // Already cancelled before the call even reached the executor — a tool call
    // dispatched just before the abort landed, or a delegate unwinding. The
    // executor is not called at all: a backend that ignores its signal would
    // otherwise spend a live upstream request on a turn nobody will read.
    // `read_url`'s own guard still stands ahead of this one, because the egress
    // guard's DNS lookup happens before control reaches here.
    if (signal.aborted) throw new WebBackendCancelledError("turn cancelled");

    const abort = rejectOnAbort(signal);
    try {
      return await Promise.race([Promise.resolve(run(signal)), abort.promise]);
    } finally {
      abort.release();
    }
  } catch (cause) {
    if (deadline.signal.aborted) {
      throw new WebBackendTimeoutError(
        `executor timed out after ${timeoutMs}ms`,
      );
    }
    if (caller?.aborted) {
      throw new WebBackendCancelledError("turn cancelled");
    }
    throw cause;
  } finally {
    clearTimeout(timer);
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
  //
  // `details` carries whatever the outcome cannot be diagnosed without — the
  // throw for a failure, the URL and policy `reason` for a block. A blocked
  // egress used to emit this line *and* a second, `fetchUrl`-shaped one carrying
  // the same reason; one structured record per call is easier to consume.
  //
  // The message is outcome-derived rather than fixed. Folding the two lines into
  // one must not cost the *event* its name: a block is not an executor failure —
  // the executor was never called — and `fetchUrl` logs this exact policy event
  // under this exact message ([tools/fetch.ts]), so an Operator alerting on
  // blocked egress keys on one string across both tools that fetch a
  // model-supplied URL.
  //
  // `durationMs` therefore means "time spent in this call so far", not "time in
  // the executor": on the `blocked` path it measures the egress guard's DNS
  // resolution, since that is all that ran.
  const logCall = (
    toolName: string,
    outcome: "ok" | "timeout" | "blocked" | "error" | "cancelled",
    startedAt: number,
    details?: Record<string, unknown>,
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
      return;
    }
    // `cancelled` sits with `ok` at debug rather than with the failures at warn.
    // A User pressing stop is not a fault — it is the single most ordinary way for
    // a long search to end — and warning on it would make an Operator's healthy
    // traffic noisy enough to hide the outcomes that are faults. The `cause` still
    // rides the line for anyone reading at debug.
    if (outcome === "cancelled") {
      logger.debug(
        { ...line, ...details },
        "Web backend executor call cancelled",
      );
      return;
    }
    logger.warn(
      { ...line, ...details },
      outcome === "blocked"
        ? "Blocked a model-supplied URL by network policy"
        : "Web backend executor call failed",
    );
  };

  /**
   * The one place a throw out of an executor becomes a model-facing result.
   *
   * Three outcomes, two model-facing strings: cancellation deliberately reuses
   * the failure text rather than adding a third. In practice the model never
   * reads the cancelled one — the turn that would have read it is the turn being
   * torn down — and a string nobody reads is not worth another one for a
   * Contribution author to learn.
   */
  const failed = (
    toolName: string,
    cause: unknown,
    startedAt: number,
  ): WebToolError => {
    if (cause instanceof WebBackendCancelledError) {
      logCall(toolName, "cancelled", startedAt, { cause });
      return { error: failureMessage(toolName) };
    }
    const timedOut = cause instanceof WebBackendTimeoutError;
    logCall(toolName, timedOut ? "timeout" : "error", startedAt, { cause });
    return {
      error: timedOut
        ? timeoutMessage(toolName, timeoutMs)
        : failureMessage(toolName),
    };
  };

  const buildSearchTool = (
    webSearch: WebBackendExecutors["web_search"],
  ): Tool =>
    tool({
      description: WEB_SEARCH_DESCRIPTION,
      metadata: WEB_BACKEND_TOOL_METADATA,
      inputSchema: webSearchInputSchema,
      execute: async (
        { query },
        { abortSignal },
      ): Promise<WebSearchToolResult | WebToolError> => {
        const startedAt = Date.now();
        logger.debug(
          { backend, plugin: pluginName, query },
          "web_search query",
        );

        let raw: unknown;
        try {
          raw = await withDeadline(
            (signal) => webSearch({ query }, { signal }),
            timeoutMs,
            abortSignal,
          );
        } catch (cause) {
          return failed("web_search", cause, startedAt);
        }

        const payload = asRecord(raw);
        const entries: readonly unknown[] = Array.isArray(payload.results)
          ? payload.results
          : [];

        const results: WebSearchToolResult["results"] = [];
        // Counted apart, not as one `dropped` total: an unusable *scheme* is a bug
        // (or worse) in the backend, an over-length URL is routine noise from some
        // upstreams, and an Operator reading the line needs to tell them apart.
        // `droppedNoUrl` is the third case for the same reason — an entry whose
        // `url` is not a string at all (absent, null, a number, an object) is a
        // malformed payload, and folding it into `droppedLength` made a broken
        // backend read as routine noise.
        let droppedNoUrl = 0;
        let droppedLength = 0;
        let droppedScheme = 0;
        // Bounded on both ends: `MAX_SEARCH_RESULTS` on what is kept, and
        // `MAX_SEARCH_RESULT_SCAN` on what is even looked at, so a pathological
        // result array cannot spend core's CPU parsing URLs it will discard.
        const scanned = entries.slice(0, MAX_SEARCH_RESULT_SCAN);
        for (const candidate of scanned) {
          if (results.length >= MAX_SEARCH_RESULTS) break;
          const entry = asRecord(candidate);
          // Length before scheme, deliberately: `isPresentableUrl` parses the whole
          // string with `new URL()`, and the CPU argument behind
          // `MAX_SEARCH_RESULT_SCAN` applies just as much to a URL core is about to
          // discard — otherwise a scan's worth of multi-megabyte hrefs gets fully
          // parsed on the way to being dropped. Every case drops rather than
          // truncates: a cut URL is a broken link, worse than no link.
          if (typeof entry.url !== "string") {
            droppedNoUrl += 1;
            continue;
          }
          if (entry.url.length > MAX_URL_CHARS) {
            droppedLength += 1;
            continue;
          }
          if (!isPresentableUrl(entry.url)) {
            droppedScheme += 1;
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
        // `debug`, not `warn`: this is per-call and model-triggerable, and for some
        // upstreams (Brave and Tavily both mix in results core cannot present) it is
        // expected steady state rather than a fault — at `warn` a healthy backend
        // would log on every search a user runs. The line below stays at `warn`
        // because it means the *backend* is misbehaving, not merely noisy.
        if (droppedNoUrl > 0 || droppedLength > 0 || droppedScheme > 0) {
          logger.debug(
            {
              backend,
              plugin: pluginName,
              droppedNoUrl,
              droppedLength,
              droppedScheme,
            },
            "Dropped web_search results with an unusable URL",
          );
        }
        // Only the *scan* bound warrants this warning: if the result cap already
        // filled every slot (the `break` above), the unscanned tail was never
        // needed and nothing was lost to `MAX_SEARCH_RESULT_SCAN`. Warn only when
        // a slot was still open and there was more the scan bound kept us from
        // looking at.
        if (
          results.length < MAX_SEARCH_RESULTS &&
          entries.length > scanned.length
        ) {
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
      metadata: WEB_BACKEND_TOOL_METADATA,
      inputSchema: readUrlInputSchema,
      execute: async (
        { url, max_length, start_index },
        { abortSignal },
      ): Promise<ReadUrlToolResult | WebToolError> => {
        const startedAt = Date.now();
        logger.debug({ backend, plugin: pluginName, url }, "read_url target");

        // `withDeadline` refuses an already-cancelled call too, so this is not
        // the only guard — it is the *earlier* one, and it is here rather than
        // there because the egress guard resolves DNS on the way. A turn that has
        // already been cancelled has no reason to spend a lookup on a page nobody
        // will read.
        if (abortSignal?.aborted) {
          return failed(
            "read_url",
            new WebBackendCancelledError("turn cancelled"),
            startedAt,
          );
        }

        // The URL comes from the model, so it is vetted before anything reaches
        // the network — the whole reason core, not the backend, owns this Tool.
        const egress = await checkEgress(url, { resolve: resolveHostname });
        if (!egress.allowed) {
          // One line, not two: `url` and `reason` ride the outcome record. The
          // URL is user content and normally debug-only (D9), but a block cannot
          // be diagnosed without the address that was refused.
          logCall("read_url", "blocked", startedAt, {
            url,
            reason: egress.reason,
          });
          return { error: EGRESS_BLOCKED_MESSAGE };
        }

        let raw: unknown;
        try {
          raw = await withDeadline(
            (signal) => readUrl({ url }, { signal }),
            timeoutMs,
            abortSignal,
          );
        } catch (cause) {
          return failed("read_url", cause, startedAt);
        }

        // Cap first, then slice within the capped string: the cap bounds what core
        // ever holds, the slice serves this page of it.
        const payload = asRecord(raw);
        if (typeof payload.content !== "string") {
          // Every other narrowing path here warns; this one didn't, so a
          // malformed payload previously read as a silent, successful empty
          // page — indistinguishable from a page that is genuinely empty.
          logger.warn(
            { backend, plugin: pluginName, url },
            "Web backend read_url returned no content",
          );
        }
        const full = typeof payload.content === "string" ? payload.content : "";
        const capped = full.length > MAX_READ_URL_CONTENT_CHARS;
        if (capped) {
          logger.warn(
            { backend, plugin: pluginName, url, length: full.length },
            "Web backend read_url content exceeded the core cap and was truncated",
          );
        }
        const content = capped
          ? full.slice(0, MAX_READ_URL_CONTENT_CHARS)
          : full;

        // Clamped, not schema-rejected: `max_length` mirrors `fetchUrl`'s bound so
        // the two tools accept the same requests, and core narrows the page here.
        // Silent by design — `next_start_index` below already tells the model the
        // read continues, which is the only thing it needs to act on.
        const pageLength = Math.min(max_length, MAX_READ_URL_SLICE_CHARS);
        const slice = content.slice(start_index, start_index + pageLength);
        const hasMore = start_index + pageLength < content.length;
        const next_start_index = start_index + pageLength;

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
          // Bounded by `MAX_URL_CHARS` down every branch — see
          // `presentableReadUrl`.
          url: presentableReadUrl(payload.url, url),
          // Sliced bare rather than through `truncate`: a `…` marker is right for
          // prose a model reads, but `content_type` is machine-readable and a
          // marked cut yields an invalid MIME type instead of a shortened one.
          content_type:
            typeof payload.contentType === "string"
              ? payload.contentType.slice(0, MAX_CONTENT_TYPE_CHARS)
              : "",
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
    buildTurnTools: async (ctx: TurnToolsContext) => {
      // The Provider row is core's to know and no business of a backend's, so
      // it is stripped before the plugin-facing call and kept for the warns:
      // `createExecutors` still receives exactly the `WebBackendContext`
      // ADR-0014 fixes at `{ orgId, workspaceId, userId }` plus the optional
      // registrar. The strip has to happen before the registrar is attributed,
      // or the spread inside that helper would put `providerId` back.
      const { providerId, ...coreCtx } = ctx;

      // One context for both warns below. They report the same fault to the
      // same reader — an Operator asked why a reply said search was unavailable
      // (issue #522) — and the fields they need are identical, so drift between
      // two literals is the only thing separate ones would buy.
      const faultCtx = {
        plugin: pluginName,
        backend,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        providerId,
      };

      // A factory that throws or hangs must degrade exactly like the
      // missing-`web_search` case below, not reject/pin the turn: ADR-0014's
      // "runtime resolution graceful" and the timeout's "a backend cannot pin a
      // turn open" both apply to the factory call, not just the executors it
      // returns.
      //
      // This window is *additive* to the executors': `buildTurnTools` runs once
      // per turn and each tool call gets its own `timeoutMs`, so the worst case a
      // turn can spend inside a backend is `(1 + calls) × timeoutMs` — 240s for a
      // single search at the 120s boot ceiling. Still bounded, which is the
      // property the ceiling exists to protect, but no longer one window.
      // The *context* is derived so a closer this backend registers is logged
      // against the plugin and backend that registered it. The **contribution**
      // is passed through untouched — that invariant is about `this`, not `ctx`.
      const factoryCtx: WebBackendContext = withAttributedRegistrar(coreCtx, {
        plugin: pluginName,
        backend,
      });

      let executors: WebBackendExecutors | undefined;
      try {
        // No caller signal here, deliberately: the prepare phase has no abort of
        // its own to hand over yet, so this call behaves exactly as it did before
        // executors gained a signal. Wiring one in is its own change.
        executors = await withDeadline(
          () => contribution.createExecutors(factoryCtx, plugin),
          timeoutMs,
        );
      } catch (cause) {
        // The turn's scope and Provider ride this warn and the one below
        // because what they report is now an Unavailable capability shown to
        // the User (issue #522), not only a line in the log: an Operator asked
        // about that notice needs the Workspace that saw it and the Provider
        // row they have to edit, not just the plugin that failed.
        const timedOut = cause instanceof WebBackendTimeoutError;
        logger.warn(
          { ...faultCtx, cause },
          timedOut
            ? "Web backend's createExecutors timed out; serving no tools this turn"
            : "Web backend's createExecutors threw; serving no tools this turn",
        );
        return {};
      }

      // The TS type makes `web_search` required, but a third-party JS plugin can
      // return anything. Boot stays fail-loud (the loader rejects a missing
      // `createExecutors`); runtime resolution stays graceful, so a malformed
      // executor object costs the turn its search tools, not the turn.
      if (typeof executors?.web_search !== "function") {
        logger.warn(
          faultCtx,
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
