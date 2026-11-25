"use client";

import type { ToolUIPart } from "ai";
import {
  isPresentableUrl,
  WEB_TOOL_NORMALIZED_KEY,
  type NormalizedWebToolResult,
} from "@platypus/schemas";
import { toolCallDurationMs } from "@/lib/tool-duration";
import { Tool, ToolContent, ToolHeader } from "./ai-elements/tool";

export type WebSearchSource = { url: string; title: string };

export function normalizedWebTool(part: {
  toolMetadata?: Record<string, unknown>;
}): NormalizedWebToolResult | null {
  return (
    (part.toolMetadata?.[WEB_TOOL_NORMALIZED_KEY] as
      NormalizedWebToolResult | undefined) ?? null
  );
}

export function isNormalizedWebToolPart(part: {
  toolMetadata?: Record<string, unknown>;
}): boolean {
  return normalizedWebTool(part) !== null;
}

export function webSearchSources(
  parts:
    | ReadonlyArray<{ type: string; toolMetadata?: Record<string, unknown> }>
    | undefined,
): WebSearchSource[] {
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
}

export function webToolTitle(kind: NormalizedWebToolResult["kind"]): string {
  switch (kind) {
    case "search":
      return "Web search";
    case "page":
      return "Opened page";
    case "find":
      return "Searched page for text";
  }
}

function labelFor(result: NormalizedWebToolResult): string | undefined {
  switch (result.kind) {
    case "search":
      return result.query;
    case "page":
    case "find":
      return result.url;
  }
}

function SearchBody({
  result,
  toolPart,
}: {
  result: Extract<NormalizedWebToolResult, { kind: "search" }>;
  toolPart: ToolUIPart;
}) {
  // why: no count until there is an output, or a live search reads 0 results
  if (
    toolPart.state === "input-streaming" ||
    toolPart.state === "input-available"
  ) {
    return <p className="text-muted-foreground text-xs">Searching…</p>;
  }
  if (toolPart.state !== "output-available") return null;

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
}

function PageBody({
  result,
}: {
  result: Extract<NormalizedWebToolResult, { kind: "page" }>;
}) {
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
}

function FindBody({
  result,
}: {
  result: Extract<NormalizedWebToolResult, { kind: "find" }>;
}) {
  return result.pattern ? (
    <p className="text-muted-foreground text-xs">
      Searched for &ldquo;{result.pattern}&rdquo;
    </p>
  ) : (
    <p className="text-muted-foreground text-xs">Searching page…</p>
  );
}

export function WebToolCard({
  toolPart,
  messageMetadata,
  cleared,
}: {
  toolPart: ToolUIPart;
  // why: passed in, as SubAgentTool does — a duration needs the message's carrier
  messageMetadata?: unknown;
  cleared?: boolean;
}) {
  const result = normalizedWebTool(toolPart);
  if (!result) return null;

  // why: a backend error arrives as output, so fold errorText and result.error
  const errorText = toolPart.errorText ?? result.error ?? null;

  return (
    <Tool>
      <ToolHeader
        title={webToolTitle(result.kind)}
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
        <div className="flex flex-col gap-2 text-sm">
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
}
