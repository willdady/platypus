import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ToolUIPart } from "ai";

// Streamdown pulls in shiki and a worker-ish runtime that jsdom can't host; the
// assertions here only care about the card's header.
vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { SubAgentTool, SUB_AGENT_CUT_SHORT_NOTICE } from "./sub-agent-tool";

const delegateCall = (toolMetadata?: Record<string, unknown>): ToolUIPart =>
  ({
    type: "tool-delegateToResearchBot",
    toolCallId: "call-1",
    state: "output-available",
    input: { task: "Find the release date" },
    output: { entries: [], text: "It shipped in March." },
    toolMetadata,
  }) as unknown as ToolUIPart;

const truncatedDelegateCall = (
  entries: Array<Record<string, unknown>> = [],
): ToolUIPart =>
  ({
    type: "tool-delegateToResearchBot",
    toolCallId: "call-1",
    state: "output-available",
    input: { task: "Find the release date" },
    output: {
      entries,
      text: "It shipped in Mar",
      truncatedByTokenLimit: true,
    },
  }) as unknown as ToolUIPart;

// A delegated run is the longest thing that happens in a chat, so its card is
// the one where the duration matters most.
describe("SubAgentTool duration", () => {
  it("renders the recorded duration in the header", () => {
    render(<SubAgentTool toolPart={delegateCall({ durationMs: 42_000 })} />);

    expect(screen.getByText(/42\.0s/)).toBeInTheDocument();
  });

  it("renders no duration for a delegation recorded before timing existed", () => {
    render(<SubAgentTool toolPart={delegateCall()} />);

    expect(screen.getByText("Research Bot")).toBeInTheDocument();
    expect(screen.queryByText(/\d+(\.\d+)?(ms|s)/)).toBeNull();
  });
});

// Issue #442. The card shows the delegate's answer verbatim, so a fragment
// reads as a finished finding to the person as much as to the parent Agent.
describe("SubAgentTool cut-short marker", () => {
  // The card is collapsed by default and the response lives inside it, so the
  // marker is only reachable once the card is opened.
  const renderExpanded = (toolPart: ToolUIPart) => {
    render(<SubAgentTool toolPart={toolPart} />);
    fireEvent.click(screen.getByRole("button"));
  };

  it("marks a response that stopped at the output limit", () => {
    renderExpanded(truncatedDelegateCall());

    expect(screen.getByText(SUB_AGENT_CUT_SHORT_NOTICE)).toBeInTheDocument();
  });

  it("marks it alongside an activity log too", () => {
    renderExpanded(
      truncatedDelegateCall([
        { type: "tool-call", toolName: "webFetch", status: "completed" },
      ]),
    );

    expect(screen.getByText(SUB_AGENT_CUT_SHORT_NOTICE)).toBeInTheDocument();
  });

  it("says nothing about a delegation that finished on its own", () => {
    renderExpanded(delegateCall());

    expect(screen.getByText("It shipped in March.")).toBeInTheDocument();
    expect(screen.queryByText(SUB_AGENT_CUT_SHORT_NOTICE)).toBeNull();
  });
});
