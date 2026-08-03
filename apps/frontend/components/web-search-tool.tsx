"use client";

import type { ToolUIPart } from "ai";
import { isPresentableUrl } from "@platypus/schemas";
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
 * `source-url` parts. `providerExecuted` is what separates the two: the AI SDK
 * sets it on a provider-executed call and leaves it unset on ours.
 *
 * Both the Sources lifting and the compact card gate on this one predicate, so a
 * native search keeps the generic renderer — and its real payload — rather than a
 * card that reports "0 results" for a search that returned ten.
 */
export const isPluginWebSearchPart = (part: {
  type: string;
  providerExecuted?: boolean;
}): boolean =>
  part.type === "tool-web_search" && part.providerExecuted !== true;

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
 * Deduplicated by URL, first occurrence winning, so two searches in one turn that
 * both surface a page cite it once. `alreadyCited` seeds that set with the URLs
 * another row already renders — the native `source-url` parts — so a page cited
 * both ways in one message is one pill and counts once.
 */
export const webSearchSources = (
  parts:
    | ReadonlyArray<{
        type: string;
        output?: unknown;
        providerExecuted?: boolean;
      }>
    | undefined,
  alreadyCited?: Iterable<string>,
): WebSearchSource[] => {
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>(alreadyCited);
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
  const results = Array.isArray(output.results) ? output.results : [];
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
              {/* Only once there is an output to count. Before that the same
              line would read "0 results" for a search still in flight. */}
              {toolPart.state === "output-available" ? (
                <p className="text-muted-foreground text-xs">
                  {results.length === 1
                    ? "1 result"
                    : `${results.length} results`}
                  {results.length > 0 && " — listed above as sources"}
                </p>
              ) : (
                <p className="text-muted-foreground text-xs">Searching…</p>
              )}
            </>
          )}
        </div>
      </ToolContent>
    </Tool>
  );
};
