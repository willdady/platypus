"use client";

import type { ToolUIPart } from "ai";
import { isPresentableUrl, WEB_BACKEND_TOOL_MARKER } from "@platypus/schemas";
import { Tool, ToolContent, ToolHeader } from "./ai-elements/tool";

/**
 * One citation lifted out of a Web-search backend's `web_search` result.
 *
 * The shape mirrors the backend's `WebSearchToolResult` (core owns it — the
 * backend supplies only executors, ADR-0014), but it is narrowed at runtime here
 * rather than imported as a type: this is stored message content read back from
 * the database, and `url` becomes an `href`.
 */
export type WebSearchSource = { url: string; title: string };

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

/**
 * Whether a message part is a **plugin** `web_search` call — the client-executed
 * kind a Web-search backend contributes (ADR-0014).
 *
 * The tool name alone does not identify one. Native provider search registers
 * under the same `web_search` key on OpenAI, OpenRouter and Anthropic
 * (`services/provider.ts`), so its parts are `tool-web_search` too — but they are
 * executed by the provider, carry a vendor-shaped output, and cite through
 * `source-url` parts. Getting this wrong either way is visible: a native search on
 * the compact card claims "0 results" for a search that returned ten, and a plugin
 * search on the generic renderer loses its Sources pills.
 *
 * Four checks, in order of how much each one actually knows:
 *
 * 1. `providerExecuted` is definitive where a provider sets it. Anthropic and
 *    OpenAI both set it from the first chunk, so a native call on either is
 *    excluded before anything else runs.
 * 2. `WEB_BACKEND_TOOL_MARKER` is the positive half, and the only check that does
 *    not depend on a vendor reporting itself — core stamps it on the Tool it
 *    builds, and the AI SDK carries it to the part. `@openrouter/ai-sdk-provider`
 *    never sets `providerExecuted`, so without this a native OpenRouter search
 *    would land on the card exactly as before.
 * 3. Core's own result shape, for a finished call carrying no marker: a message
 *    stored before the marker shipped. Native payloads are vendor-shaped (an array
 *    on Anthropic, a status object on OpenAI), so they do not match.
 * 4. An unfinished call cannot be decided on its output, and by here it has no
 *    marker either. The SDK attaches the marker on the first streaming chunk
 *    (`ai@7`, `tool-input-start`), so one of our own calls is already marked at
 *    `input-streaming` and matched by check 2 — the only parts reaching this point
 *    are the unmarked native ones, which belong on the generic renderer.
 *
 * Anything left over reads as native. That is the safe default: an unrecognised
 * `web_search` keeps the generic renderer, which shows whatever it really is.
 */
export const isPluginWebSearchPart = (part: {
  type: string;
  state?: string;
  output?: unknown;
  toolMetadata?: Record<string, unknown>;
  providerExecuted?: boolean;
}): boolean => {
  if (part.type !== "tool-web_search") return false;
  if (part.providerExecuted === true) return false;
  if (part.toolMetadata?.[WEB_BACKEND_TOOL_MARKER] === true) return true;
  if (part.state === "output-available") {
    const output = asRecord(part.output);
    return Array.isArray(output.results) || typeof output.error === "string";
  }
  return false;
};

/**
 * The citations a plugin `web_search` result contributes to the Sources row.
 *
 * Native provider search arrives as `source-url` message parts and needs none of
 * this. A Web-search backend's search is **client-executed** — the result comes
 * back as an ordinary tool part — so without lifting it, the same Chat toggle
 * gives citation pills on Anthropic and nothing on vLLM.
 *
 * Every URL is re-checked with `isPresentableUrl`, the same predicate the backend
 * drops unpresentable results with. Belt-and-braces on one rule, and this is the
 * copy that decides what becomes an `href`: a `javascript:` or `data:` URL in a
 * clickable pill is a live hole, and a backend is third-party code.
 *
 * Scheme only, deliberately: length is core's, which drops a result URL over
 * `MAX_URL_CHARS` and truncates a title to `MAX_TITLE_CHARS` before either is
 * stored, and an over-long pill is a layout complaint rather than a hole.
 *
 * Deduplicated by URL, first occurrence winning, so two searches in one turn that
 * both surface a page cite it once. Deduplication *against* the native
 * `source-url` row happens where both are rendered — see `chat-message.tsx`.
 */
export const webSearchSources = (
  parts:
    | ReadonlyArray<{
        type: string;
        state?: string;
        output?: unknown;
        toolMetadata?: Record<string, unknown>;
        providerExecuted?: boolean;
      }>
    | undefined,
): WebSearchSource[] => {
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  for (const part of parts ?? []) {
    if (!isPluginWebSearchPart(part)) continue;
    const results = asRecord(part.output).results;
    if (!Array.isArray(results)) continue;
    for (const entry of results) {
      const { url, title } = asRecord(entry);
      if (!isPresentableUrl(url) || seen.has(url)) continue;
      seen.add(url);
      sources.push({
        url,
        title: typeof title === "string" && title !== "" ? title : url,
      });
    }
  }
  return sources;
};

/**
 * The `web_search` tool card.
 *
 * Deliberately not the generic tool renderer: a client-executed search whose
 * results are already rendered as Sources pills would otherwise repeat all of them
 * as a raw JSON body, where native search shows pills alone. The card stays for
 * what the pills cannot say — that a search ran, what was searched for, and when
 * it failed.
 */
export const WebSearchTool = ({ toolPart }: { toolPart: ToolUIPart }) => {
  const query = asRecord(toolPart.input).query;
  const output = asRecord(toolPart.output);
  // The tool's contract is a returned `{ error }`, not a rejection, so a failed
  // search arrives with `state: "output-available"` and no `errorText`.
  const errorText =
    toolPart.errorText ??
    (typeof output.error === "string" ? output.error : null);
  // Counted through the same helper the Sources row is built from, not off the raw
  // array: the row lists only the results that survive `isPresentableUrl`, so a
  // backend returning three results with two `javascript:` URLs would otherwise say
  // "3 results — listed above as sources" above a single pill.
  //
  // This call's own results, deliberately: the count belongs to the card it sits in.
  // Two searches in one turn that both surface a page therefore total one more than
  // the row's pill count, which deduplicates across the whole message — the
  // alternative is a card reporting a number that has nothing to do with the search
  // it heads.
  const shownCount = webSearchSources([toolPart]).length;
  const answer = typeof output.answer === "string" ? output.answer : null;

  return (
    <Tool>
      <ToolHeader
        title="Web search"
        label={typeof query === "string" ? query : undefined}
        type="tool-web_search"
        state={errorText ? "output-error" : toolPart.state}
      />
      <ToolContent>
        <div className="space-y-2 p-4 text-sm">
          {errorText ? (
            <p className="text-destructive text-xs">{errorText}</p>
          ) : (
            <>
              {answer && <p className="text-muted-foreground">{answer}</p>}
              {/* A count only once there is an output to count — the same line
              would otherwise read "0 results" for a search still in flight — and
              "Searching…" only for the two states where one genuinely is. The
              remaining states (a denied call, an `output-error` that arrived
              without `errorText`) get neither: both are already reported by the
              header, and claiming a search is running would be false. */}
              {toolPart.state === "output-available" ? (
                <p className="text-muted-foreground text-xs">
                  {shownCount === 1 ? "1 result" : `${shownCount} results`}
                  {shownCount > 0 && " — listed above as sources"}
                </p>
              ) : toolPart.state === "input-streaming" ||
                toolPart.state === "input-available" ? (
                <p className="text-muted-foreground text-xs">Searching…</p>
              ) : null}
            </>
          )}
        </div>
      </ToolContent>
    </Tool>
  );
};
