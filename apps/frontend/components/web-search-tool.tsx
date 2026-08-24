"use client";

import type { ToolUIPart } from "ai";
import {
  isPresentableUrl,
  WEB_TOOL_NORMALIZED_KEY,
  type NormalizedWebToolResult,
} from "@platypus/schemas";
import { toolCallDurationMs } from "@/lib/tool-duration";
import { Tool, ToolContent, ToolHeader } from "./ai-elements/tool";

/**
 * One citation lifted out of a Web-search backend's `web_search` result.
 *
 * Native provider search never contributes here — see `webSearchSources`.
 */
export type WebSearchSource = { url: string; title: string };

/**
 * The normalized web-tool view a message part carries, computed server-side
 * (issue #525, `apps/backend/src/runs/web-tool-normalize.ts`) — `null` when
 * the backend did not recognise this part as a web tool at all, in which case
 * it renders on the generic tool renderer instead.
 *
 * This is the ONLY thing the frontend reads to decide what a `web_search`,
 * `google_search`, `read_url` or `fetchUrl` part looks like. It holds no
 * vendor knowledge of its own: ownership (a Web-search backend's tool vs. a
 * Provider's native search) and the per-vendor read of a native result are
 * both decided once, on the backend, never re-derived here from the payload.
 */
export const normalizedWebTool = (part: {
  toolMetadata?: Record<string, unknown>;
}): NormalizedWebToolResult | null =>
  (part.toolMetadata?.[WEB_TOOL_NORMALIZED_KEY] as
    NormalizedWebToolResult | undefined) ?? null;

/** Whether a message part is one the Web tool block should render. */
export const isNormalizedWebToolPart = (part: {
  toolMetadata?: Record<string, unknown>;
}): boolean => normalizedWebTool(part) !== null;

/**
 * The citations a Web-search backend's `web_search` result contributes to the
 * Sources row.
 *
 * Native provider search arrives as `source-url` message parts and needs none
 * of this. A native search's normalized result never carries `results` —
 * citation-lifting deliberately does not widen to it (issue #525): the
 * Provider emits its own citation parts for the pages it actually used, while
 * a native search's raw result list is every page it found, cited or not.
 *
 * Every URL is re-checked with `isPresentableUrl`, the same predicate the
 * backend drops unpresentable results with. Belt-and-braces on one rule, and
 * this is the copy that decides what becomes an `href`.
 *
 * Deduplicated by URL, first occurrence winning, so two searches in one turn
 * that both surface a page cite it once.
 */
export const webSearchSources = (
  parts:
    | ReadonlyArray<{ type: string; toolMetadata?: Record<string, unknown> }>
    | undefined,
): WebSearchSource[] => {
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  for (const part of parts ?? []) {
    const result = normalizedWebTool(part);
    if (!result || result.kind !== "search" || !result.results) continue;
    for (const entry of result.results) {
      if (!isPresentableUrl(entry.url) || seen.has(entry.url)) continue;
      seen.add(entry.url);
      sources.push({
        url: entry.url,
        title: entry.title !== "" ? entry.title : entry.url,
      });
    }
  }
  return sources;
};

const titleFor = (kind: NormalizedWebToolResult["kind"]): string => {
  switch (kind) {
    case "search":
      return "Web search";
    case "page":
      return "Opened page";
    case "find":
      return "Searched page for text";
  }
};

const labelFor = (result: NormalizedWebToolResult): string | undefined => {
  switch (result.kind) {
    case "search":
      return result.query;
    case "page":
    case "find":
      return result.url;
  }
};

const SearchBody = ({
  result,
  toolPart,
}: {
  result: Extract<NormalizedWebToolResult, { kind: "search" }>;
  toolPart: ToolUIPart;
}) => {
  // A count only once there is an output to count — showing one for a search
  // still in flight would otherwise read "0 results", and "Searching…" only
  // for the two states where one genuinely is running. A denied call is
  // neither: the header already reports that state, and claiming a search is
  // running would be false.
  if (
    toolPart.state === "input-streaming" ||
    toolPart.state === "input-available"
  ) {
    return <p className="text-muted-foreground text-xs">Searching…</p>;
  }
  if (toolPart.state !== "output-available") return null;

  // A Web-search backend's own results, counted through the same helper the
  // Sources row is built from, not off the raw array — the row lists only
  // results that survive `isPresentableUrl`. Native search has no `results`
  // at all: its count is the vendor's raw, unfiltered `resultCount`, and it
  // never gains a "listed above as sources" suffix, since its results are not
  // the pills.
  const hasOwnResults = Array.isArray(result.results);
  const shownCount = hasOwnResults
    ? webSearchSources([toolPart]).length
    : result.resultCount;

  return (
    <>
      {result.answer && (
        <p className="text-muted-foreground">{result.answer}</p>
      )}
      {shownCount !== undefined && (
        <p className="text-muted-foreground text-xs">
          {shownCount === 1 ? "1 result" : `${shownCount} results`}
          {hasOwnResults && shownCount > 0 && " — listed above as sources"}
        </p>
      )}
    </>
  );
};

const PageBody = ({
  result,
}: {
  result: Extract<NormalizedWebToolResult, { kind: "page" }>;
}) => {
  if (result.contentLength === undefined && !result.contentType) {
    return <p className="text-muted-foreground text-xs">Opening…</p>;
  }
  return (
    <p className="text-muted-foreground text-xs">
      {[
        result.contentLength !== undefined
          ? `${result.contentLength.toLocaleString()} characters`
          : null,
        result.contentType || null,
        result.truncated ? "truncated" : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    </p>
  );
};

const FindBody = ({
  result,
}: {
  result: Extract<NormalizedWebToolResult, { kind: "find" }>;
}) =>
  result.pattern ? (
    <p className="text-muted-foreground text-xs">
      Searched for &ldquo;{result.pattern}&rdquo;
    </p>
  ) : (
    <p className="text-muted-foreground text-xs">Searching page…</p>
  );

/**
 * The Web tool block: one card for a native provider search, a Web-search
 * backend's search or page read, and the web-fetch Tool set's `fetchUrl`
 * (issue #525) — a reader cannot tell which of them ran.
 *
 * Deliberately not the generic tool renderer: a native search's citations
 * already render as `source-url` pills, a plugin search's as Sources pills,
 * and a page read has content that belongs in this card's summary, not
 * dumped whole into the Transcript body.
 */
export const WebToolCard = ({
  toolPart,
  messageMetadata,
  cleared,
}: {
  toolPart: ToolUIPart;
  /**
   * The metadata of the message this invocation sits on, which is where a
   * duration arrives from mid-turn. Passed in rather than read here, the same
   * way `SubAgentTool` takes it: resolving a duration needs both carriers, and
   * the composing message already holds them.
   */
  messageMetadata?: unknown;
  /** Tool-result clearing (ADR-0018 Notes, issue #524) left this result out
   *  of the next model call. */
  cleared?: boolean;
}) => {
  const result = normalizedWebTool(toolPart);
  if (!result) return null;

  // The tool's contract is a returned `{ error }` for a core-built tool, not
  // a rejection, so a failed backend call arrives with `state:
  // "output-available"` and no `errorText` — the normalizer already folded
  // both into `result.error`.
  const errorText = toolPart.errorText ?? result.error ?? null;

  return (
    <Tool>
      <ToolHeader
        title={titleFor(result.kind)}
        label={labelFor(result)}
        type={toolPart.type}
        state={errorText ? "output-error" : toolPart.state}
        durationMs={toolCallDurationMs(
          toolPart.toolMetadata,
          messageMetadata,
          toolPart.toolCallId,
        )}
        cleared={cleared}
      />
      <ToolContent>
        <div className="space-y-2 p-4 text-sm">
          {errorText ? (
            <p className="text-destructive text-xs">{errorText}</p>
          ) : result.kind === "search" ? (
            <SearchBody result={result} toolPart={toolPart} />
          ) : result.kind === "page" ? (
            <PageBody result={result} />
          ) : (
            <FindBody result={result} />
          )}
        </div>
      </ToolContent>
    </Tool>
  );
};
