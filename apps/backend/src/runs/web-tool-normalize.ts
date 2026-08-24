import { isToolUIPart } from "ai";
import {
  WEB_BACKEND_TOOL_MARKER,
  WEB_TOOL_KNOWN_NATIVE_SEARCH_NAMES,
  WEB_TOOL_NORMALIZED_KEY,
  type NormalizedWebToolResult,
} from "@platypus/schemas";
import type { PlatypusUIMessage } from "../types.ts";

// Everything read here is `unknown` on purpose: a native payload is vendor
// JSON the AI SDK hands through untouched, and a backend/plugin payload is
// core's own shape but reached the same way `composeWebBackend` reaches a
// plugin's — narrowed field by field, never trusted structurally.
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const isPageToolName = (toolName: string): boolean =>
  toolName === "read_url" || toolName === "fetchUrl";

/**
 * Anthropic's `webSearch_20250305` output: `Array<web_search_result>`, each
 * entry carrying `url`, `title`, `pageAge` and a large `encryptedContent`
 * field core must never surface. Only the count is read — the array is never
 * echoed, which is what stops `encryptedContent` reaching the Transcript.
 */
const normalizeAnthropicSearch = (
  query: string | undefined,
  results: readonly unknown[],
): NormalizedWebToolResult => ({
  kind: "search",
  query,
  resultCount: results.length,
});

/**
 * OpenAI's hosted web tool: `{ action, sources? }`, one tool name covering a
 * search, an opened page, and an in-page find. `action.type` is the only thing
 * that says which occurred; a missing `action` (or an unrecognised `type`) is
 * read as a search, the vendor's own minimal case.
 *
 * `action.type` is `"search" | "openPage" | "findInPage"` — camelCase, per
 * `@ai-sdk/openai@4.0.27`'s `webSearchToolFactory` output type — unlike the
 * tool's own snake_case name (`web_search`) and its sibling `read_url`.
 *
 * `sources` is an **optional** array of `{type:"url",url}` / `{type:"api",name}`
 * entries — present only when the vendor chooses to report it, which is why a
 * count is omitted rather than shown as zero when it is absent.
 */
const normalizeOpenAiOutput = (
  output: Record<string, unknown>,
): NormalizedWebToolResult => {
  const action = asRecord(output.action);
  const type = asString(action.type);

  if (type === "openPage") {
    return { kind: "page", url: asString(action.url) };
  }
  if (type === "findInPage") {
    return {
      kind: "find",
      url: asString(action.url),
      pattern: asString(action.pattern),
    };
  }

  const queries = action.queries;
  const query =
    asString(action.query) ??
    (Array.isArray(queries) ? asString(queries[0]) : undefined);
  return {
    kind: "search",
    query,
    resultCount: Array.isArray(output.sources)
      ? output.sources.length
      : undefined,
  };
};

/**
 * A native call's finished output, read per-vendor rather than by shape guess
 * on *what tool it is* — ownership was already decided by `providerExecuted`
 * before this runs (issue #525). This only decides how to read a confirmed
 * native payload, which is unavoidably vendor-shaped: Anthropic returns an
 * array, OpenAI an `{action,...}` object.
 *
 * A shape this doesn't recognise (OpenRouter's native `webSearch` declares no
 * output type at all) returns `null` and falls to the generic renderer,
 * unreadable exactly as it was before this issue.
 */
const normalizeNativeOutput = (
  input: unknown,
  output: unknown,
): NormalizedWebToolResult | null => {
  if (Array.isArray(output)) {
    return normalizeAnthropicSearch(asString(asRecord(input).query), output);
  }
  const record = asRecord(output);
  if ("action" in record || "sources" in record) {
    return normalizeOpenAiOutput(record);
  }
  return null;
};

/**
 * A core-built tool's finished output — a Web-search backend's `web_search` /
 * `read_url` (ADR-0014), or the web-fetch Tool set's `fetchUrl`. All three
 * already return core's own fixed shape, so this only relabels it, and an
 * executor failure (`{ error }`, part of the tool's success contract, not an
 * SDK rejection) is read the same way as a result.
 */
const normalizeBackendOutput = (
  toolName: string,
  input: unknown,
  output: unknown,
): NormalizedWebToolResult => {
  const record = asRecord(output);
  const isPageTool = isPageToolName(toolName);
  const error = asString(record.error);
  if (error !== undefined) {
    return isPageTool
      ? { kind: "page", url: asString(asRecord(input).url), error }
      : { kind: "search", query: asString(asRecord(input).query), error };
  }
  if (isPageTool) {
    return {
      kind: "page",
      url: asString(record.url),
      contentType: asString(record.content_type),
      contentLength:
        typeof record.content === "string" ? record.content.length : undefined,
      truncated:
        typeof record.truncated === "boolean" ? record.truncated : undefined,
    };
  }
  return {
    kind: "search",
    query: asString(record.query),
    results: Array.isArray(record.results)
      ? (record.results as Array<{
          title: string;
          url: string;
          snippet?: string;
        }>)
      : undefined,
    answer: asString(record.answer),
  };
};

/**
 * Decide, then read — the two questions issue #525 keeps separate.
 *
 * Ownership is decided first, exactly as `isPluginWebSearchPart` used to on
 * the frontend, and by the same two positive signals: core's own marker, or a
 * Provider's `providerExecuted` flag on a known native search tool name.
 * Neither is inferred from the payload. Everything else — an MCP `web_search`,
 * a native OpenRouter search, an unmarked backend result from before the
 * marker shipped — returns `null` and keeps the generic renderer, which is
 * where it belongs.
 *
 * Once ownership is settled, reading the payload is what is genuinely
 * per-vendor: `normalizeNativeOutput` and `normalizeBackendOutput` never
 * change *what* is rendered, only *how the shape is interpreted*.
 */
export const normalizeWebToolPart = (part: {
  type: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  toolMetadata?: Record<string, unknown>;
  providerExecuted?: boolean;
}): NormalizedWebToolResult | null => {
  if (!part.type.startsWith("tool-")) return null;
  const toolName = part.type.slice("tool-".length);

  const isBackendOwned = part.toolMetadata?.[WEB_BACKEND_TOOL_MARKER] === true;
  const isNativeSearch =
    !isBackendOwned &&
    part.providerExecuted === true &&
    WEB_TOOL_KNOWN_NATIVE_SEARCH_NAMES.has(toolName);

  if (!isBackendOwned && !isNativeSearch) return null;

  const isPageTool = isPageToolName(toolName);

  // An SDK-level tool error (`errorText`) rather than the `{ error }` success
  // contract a core-built tool uses — a native call is the only kind that can
  // reach this branch, since core's own tools never reject.
  if (part.errorText) {
    return isPageTool
      ? { kind: "page", error: part.errorText }
      : { kind: "search", error: part.errorText };
  }

  if (part.state !== "output-available") {
    // In flight: nothing to read yet. `kind` is a best-effort placeholder so
    // the card can show the right title as soon as it has one; OpenAI's
    // search/page/find distinction cannot be known before the output arrives,
    // the same way it never could be from the input alone.
    return isPageTool ? { kind: "page" } : { kind: "search" };
  }

  return isBackendOwned
    ? normalizeBackendOutput(toolName, part.input, part.output)
    : normalizeNativeOutput(part.input, part.output);
};

const normalizeMessage = (message: PlatypusUIMessage): PlatypusUIMessage => {
  let patched = false;
  const parts = message.parts.map((part) => {
    if (!isToolUIPart(part)) return part;
    const normalized = normalizeWebToolPart(part);
    if (!normalized) return part;
    patched = true;
    return {
      ...part,
      toolMetadata: {
        ...part.toolMetadata,
        [WEB_TOOL_NORMALIZED_KEY]: normalized,
      },
    };
  });
  return patched ? { ...message, parts } : message;
};

/**
 * Attach the normalized web-tool view to every recognised part across a set of
 * messages, without touching anything else. Called from both the live stream
 * relay (`drive.ts`) and the saved-Transcript read path (`routes/chat.ts`),
 * beside `rewriteStorageUrls` — a view computed at read/serve time, never
 * written back to storage, so the vendor payload the part actually carries
 * stays exactly what was stored (issue #525's retroactivity requirement: a
 * Chat saved before this shipped renders on the block with no migration).
 */
export const normalizeWebToolParts = (
  messages: PlatypusUIMessage[],
): PlatypusUIMessage[] => messages.map(normalizeMessage);
