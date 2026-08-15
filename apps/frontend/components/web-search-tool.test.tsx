import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ToolUIPart } from "ai";

import { WebSearchTool } from "./web-search-tool";

const searchCall = (toolMetadata?: Record<string, unknown>): ToolUIPart =>
  ({
    type: "tool-web_search",
    toolCallId: "call-1",
    state: "output-available",
    input: { query: "platypus habitat" },
    output: { query: "platypus habitat", results: [] },
    toolMetadata,
  }) as unknown as ToolUIPart;

// Issue #469. A plugin search is the tool most likely to take several seconds,
// so the card that heads it is where the elapsed time is worth reading.
describe("WebSearchTool duration", () => {
  it("renders the duration recorded on the part", () => {
    render(<WebSearchTool toolPart={searchCall({ durationMs: 4200 })} />);

    expect(screen.getByText(/4\.2s/)).toBeInTheDocument();
  });

  it("renders the duration the message carries mid-turn", () => {
    render(
      <WebSearchTool
        toolPart={searchCall()}
        messageMetadata={{ toolDurations: { "call-1": 4200 } }}
      />,
    );

    expect(screen.getByText(/4\.2s/)).toBeInTheDocument();
  });

  it("renders no duration for a search recorded before timing existed", () => {
    render(<WebSearchTool toolPart={searchCall()} />);

    expect(screen.getByText("Web search")).toBeInTheDocument();
    expect(screen.queryByText(/^\d+(\.\d+)?(ms|s)$/)).toBeNull();
  });
});
