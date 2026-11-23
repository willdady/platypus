import { isToolUIPart } from "ai";
import {
  WEB_BACKEND_TOOL_MARKER,
  WEB_TOOL_KNOWN_NATIVE_SEARCH_NAMES,
  WEB_TOOL_NORMALIZED_KEY,
  type NormalizedWebToolResult,
} from "@platypus/schemas";
import type { PlatypusUIMessage } from "../types.ts";
import { READ_URL_TOOL_NAME } from "../tools/turn-tool-names.ts";

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const isPageToolName = (toolName: string): boolean =>
  toolName === READ_URL_TOOL_NAME || toolName === "fetchUrl";

const normalizeAnthropicSearch = (
  query: string | undefined,
  results: readonly unknown[],
): NormalizedWebToolResult => ({
  kind: "search",
  query,
  resultCount: results.length,
});

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

  if (part.errorText) {
    return isPageTool
      ? { kind: "page", error: part.errorText }
      : { kind: "search", error: part.errorText };
  }

  if (part.state !== "output-available") {
    return isPageTool ? { kind: "page" } : { kind: "search" };
  }

  return isBackendOwned
    ? normalizeBackendOutput(toolName, part.input, part.output)
    : normalizeNativeOutput(part.input, part.output);
};

export const normalizeWebToolMessage = (
  message: PlatypusUIMessage,
): PlatypusUIMessage => {
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
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set in a callback, which TS narrowing does not track
  return patched ? { ...message, parts } : message;
};

// why: a read-time view, never stored, so Chats saved before it render without a migration
export const normalizeWebToolParts = (
  messages: PlatypusUIMessage[],
): PlatypusUIMessage[] => messages.map(normalizeWebToolMessage);
