import { tool, type Tool } from "ai";
import type { PluginConfigContext } from "@platypuschat/plugin-sdk";
import { isPresentableUrl, WEB_BACKEND_TOOL_MARKER } from "@platypus/schemas";
import { logger } from "../logger.ts";
import { createContributionRegistry } from "../registry/contribution-registry.ts";
import { checkEgress, EGRESS_BLOCKED_MESSAGE } from "../utils/egress-guard.ts";
import { sliceWhole } from "../utils/storable.ts";
import {
  CallerAbortedError,
  DeadlineExceededError,
  withDeadline,
} from "../utils/abort-race.ts";
import { truncate } from "../zod-issues.ts";
import { withAttributedRegistrar } from "../tools/closers.ts";
import {
  READ_URL_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "../tools/turn-tool-names.ts";
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

export const MAX_SEARCH_RESULTS = 10;
export const MAX_SNIPPET_CHARS = 500;
export const MAX_TITLE_CHARS = 200;
export const MAX_SEARCH_RESULT_SCAN = MAX_SEARCH_RESULTS * 10;
export const MAX_ANSWER_CHARS = 4_000;
export const MAX_CONTENT_TYPE_CHARS = 200;

const DEFAULT_WEB_TIMEOUT_MS = 30_000;
export const MAX_WEB_TIMEOUT_MS = 120_000;

const WEB_SEARCH_DESCRIPTION =
  "Search the web for current information. Returns a list of results with titles, URLs and snippets, and sometimes a direct answer.";

const READ_URL_DESCRIPTION =
  "Read the contents of a web page as text. Supports pagination for large pages via start_index.";

const WEB_BACKEND_TOOL_METADATA = { [WEB_BACKEND_TOOL_MARKER]: true };

const WEB_BACKENDS = createContributionRegistry<WebBackendRegistration>({
  noun: "Web backend",
});

export const registerWebBackend = (
  registration: WebBackendRegistration,
): void => {
  WEB_BACKENDS.register(registration.backend, registration);
};

export const getWebBackend = (
  backend: string,
): WebBackendRegistration | undefined => WEB_BACKENDS.get(backend);

export const getWebBackends = (): ReadonlyArray<WebBackendRegistration> =>
  WEB_BACKENDS.list();

export const clearWebBackends = (): void => WEB_BACKENDS.clear();

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const presentableReadUrl = (resolved: unknown, requested: string): string => {
  // why: length before scheme; isPresentableUrl parses the whole string
  if (
    typeof resolved === "string" &&
    resolved.length <= MAX_URL_CHARS &&
    isPresentableUrl(resolved)
  ) {
    return resolved;
  }
  if (requested.length <= MAX_URL_CHARS) return requested;
  try {
    return new URL(requested).origin;
  } catch {
    return "";
  }
};

const timeoutMessage = (toolName: string, timeoutMs: number): string =>
  `The web backend did not respond within ${timeoutMs}ms (${toolName}).`;

const failureMessage = (toolName: string): string =>
  `The web backend could not complete this ${toolName} request.`;

export interface ComposeWebBackendOptions {
  contribution: WebBackendContribution;
  backend: string;
  plugin: PluginConfigContext;
  pluginName: string;
}

export const composeWebBackend = (
  options: ComposeWebBackendOptions,
): WebBackendRegistration => {
  const { contribution, backend, plugin, pluginName } = options;
  const timeoutMs = contribution.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;

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

  const failed = (
    toolName: string,
    cause: unknown,
    startedAt: number,
  ): WebToolError => {
    if (cause instanceof CallerAbortedError) {
      logCall(toolName, "cancelled", startedAt, { cause });
      return { error: failureMessage(toolName) };
    }
    const timedOut = cause instanceof DeadlineExceededError;
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
        let droppedNoUrl = 0;
        let droppedLength = 0;
        let droppedScheme = 0;
        const scanned = entries.slice(0, MAX_SEARCH_RESULT_SCAN);
        for (const candidate of scanned) {
          if (results.length >= MAX_SEARCH_RESULTS) break;
          const entry = asRecord(candidate);
          // why: length before scheme; isPresentableUrl parses the whole string
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

        if (abortSignal?.aborted) {
          return failed(
            "read_url",
            new CallerAbortedError("turn cancelled"),
            startedAt,
          );
        }

        const egress = await checkEgress(url);
        if (!egress.allowed) {
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

        const payload = asRecord(raw);
        if (typeof payload.content !== "string") {
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
          ? sliceWhole(full, MAX_READ_URL_CONTENT_CHARS)
          : full;

        const pageLength = Math.min(max_length, MAX_READ_URL_SLICE_CHARS);
        const slice = content.slice(start_index, start_index + pageLength);
        const hasMore = start_index + pageLength < content.length;
        const next_start_index = start_index + pageLength;

        let body = slice;
        if (hasMore) {
          body += `\n\n[Content truncated. Pass start_index=${next_start_index} to continue reading.]`;
        } else if (capped) {
          body += `\n\n[Content truncated: the page exceeded the ${MAX_READ_URL_CONTENT_CHARS}-character limit and the remainder cannot be read.]`;
        }

        const result: ReadUrlToolResult = {
          content: body,
          url: presentableReadUrl(payload.url, url),
          content_type:
            typeof payload.contentType === "string"
              ? payload.contentType.slice(0, MAX_CONTENT_TYPE_CHARS)
              : "",
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
      const { providerId, ...coreCtx } = ctx;

      const faultCtx = {
        plugin: pluginName,
        backend,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        providerId,
      };

      const factoryCtx: WebBackendContext = withAttributedRegistrar(coreCtx, {
        plugin: pluginName,
        backend,
      });

      let executors: WebBackendExecutors | undefined;
      try {
        executors = await withDeadline(
          () => contribution.createExecutors(factoryCtx, plugin),
          timeoutMs,
        );
      } catch (cause) {
        const timedOut = cause instanceof DeadlineExceededError;
        logger.warn(
          { ...faultCtx, cause },
          timedOut
            ? "Web backend's createExecutors timed out; serving no tools this turn"
            : "Web backend's createExecutors threw; serving no tools this turn",
        );
        return {};
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a JS plugin can return anything
      if (typeof executors?.web_search !== "function") {
        logger.warn(
          faultCtx,
          "Web backend returned no web_search executor; serving no search tools this turn",
        );
        return {};
      }

      const tools: Record<string, Tool> = {
        [WEB_SEARCH_TOOL_NAME]: buildSearchTool(
          executors.web_search.bind(executors),
        ),
      };
      if (typeof executors.read_url === "function") {
        tools[READ_URL_TOOL_NAME] = buildReadUrlTool(
          executors.read_url.bind(executors),
        );
      }
      return tools;
    },
  };
};

export * from "./types.ts";
