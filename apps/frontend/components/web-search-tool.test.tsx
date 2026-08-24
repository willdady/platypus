import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ToolUIPart } from "ai";
import {
  WEB_TOOL_NORMALIZED_KEY,
  type NormalizedWebToolResult,
} from "@platypus/schemas";

import { WebToolCard, webSearchSources } from "./web-search-tool";

const searchCall = (
  normalized: NormalizedWebToolResult,
  extraMetadata?: Record<string, unknown>,
): ToolUIPart =>
  ({
    type: "tool-web_search",
    toolCallId: "call-1",
    state: "output-available",
    input: { query: "platypus habitat" },
    output: {},
    toolMetadata: {
      ...extraMetadata,
      [WEB_TOOL_NORMALIZED_KEY]: normalized,
    },
  }) as unknown as ToolUIPart;

const backendSearch: NormalizedWebToolResult = {
  kind: "search",
  query: "platypus habitat",
  results: [],
};

/** The card's body is a closed `Collapsible` until clicked open. */
const openCard = () => fireEvent.click(screen.getByRole("button"));

// Issue #469. A plugin search is the tool most likely to take several seconds,
// so the card that heads it is where the elapsed time is worth reading.
describe("WebToolCard duration", () => {
  it("renders the duration recorded on the part", () => {
    render(
      <WebToolCard
        toolPart={searchCall(backendSearch, { durationMs: 4200 })}
      />,
    );

    expect(screen.getByText(/4\.2s/)).toBeInTheDocument();
  });

  it("renders the duration the message carries mid-turn", () => {
    render(
      <WebToolCard
        toolPart={searchCall(backendSearch)}
        messageMetadata={{ toolDurations: { "call-1": 4200 } }}
      />,
    );

    expect(screen.getByText(/4\.2s/)).toBeInTheDocument();
  });

  it("renders no duration for a search recorded before timing existed", () => {
    render(<WebToolCard toolPart={searchCall(backendSearch)} />);

    expect(screen.getByText("Web search")).toBeInTheDocument();
    expect(screen.queryByText(/^\d+(\.\d+)?(ms|s)$/)).toBeNull();
  });
});

// Issue #525. The card must be uniform whichever search ran, and citations
// must not widen to native results.
describe("WebToolCard kinds", () => {
  it("renders null when the part carries no normalized result", () => {
    const { container } = render(
      <WebToolCard
        toolPart={
          {
            type: "tool-web_search",
            toolCallId: "call-1",
            state: "output-available",
            input: {},
            output: {},
          } as unknown as ToolUIPart
        }
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a bare count for a native search, with no sources suffix", () => {
    render(
      <WebToolCard
        toolPart={searchCall({
          kind: "search",
          query: "weather",
          resultCount: 5,
        })}
      />,
    );

    openCard();
    expect(screen.getByText("5 results")).toBeInTheDocument();
    expect(screen.queryByText(/listed above as sources/)).toBeNull();
  });

  it("omits the count line entirely when a native search cannot report one", () => {
    render(
      <WebToolCard
        toolPart={searchCall({ kind: "search", query: "weather" })}
      />,
    );

    openCard();
    expect(screen.queryByText(/result/)).toBeNull();
  });

  it("titles an opened page distinctly from a search", () => {
    render(
      <WebToolCard
        toolPart={searchCall({ kind: "page", url: "https://a.test/page" })}
      />,
    );

    expect(screen.getByText("Opened page")).toBeInTheDocument();
  });

  it("titles an in-page find distinctly from a search or a page", () => {
    render(
      <WebToolCard
        toolPart={searchCall({
          kind: "find",
          url: "https://a.test/page",
          pattern: "opening hours",
        })}
      />,
    );

    expect(screen.getByText("Searched page for text")).toBeInTheDocument();
    openCard();
    expect(
      screen.getByText("Searched for “opening hours”"),
    ).toBeInTheDocument();
  });

  it("shows the backend's own error", () => {
    render(
      <WebToolCard
        toolPart={searchCall({
          kind: "search",
          query: "weather",
          error: "The web backend timed out.",
        })}
      />,
    );

    openCard();
    expect(screen.getByText("The web backend timed out.")).toBeInTheDocument();
  });
});

describe("webSearchSources", () => {
  it("lifts a Web-search backend's results", () => {
    const sources = webSearchSources([
      searchCall({
        kind: "search",
        query: "weather",
        results: [{ title: "A", url: "https://a.test" }],
      }),
    ]);

    expect(sources).toEqual([{ title: "A", url: "https://a.test" }]);
  });

  it("never lifts a native search's results, since it has none", () => {
    const sources = webSearchSources([
      searchCall({ kind: "search", query: "weather", resultCount: 5 }),
    ]);

    expect(sources).toEqual([]);
  });
});
