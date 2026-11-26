import { describe, it, expect } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ToolUIPart } from "ai";

import {
  SubAgentTool,
  SUB_AGENT_CUT_SHORT_NOTICE,
  SUB_AGENT_STEP_LIMIT_NOTICE,
} from "./sub-agent-tool";

function delegateCall(toolMetadata?: Record<string, unknown>): ToolUIPart {
  return {
    type: "tool-delegateToResearchBot",
    toolCallId: "call-1",
    state: "output-available",
    input: { task: "Find the release date" },
    output: { entries: [], text: "It shipped in March." },
    toolMetadata,
  } as unknown as ToolUIPart;
}

function truncatedDelegateCall(
  entries: Array<Record<string, unknown>> = [],
): ToolUIPart {
  return {
    type: "tool-delegateToResearchBot",
    toolCallId: "call-1",
    state: "output-available",
    input: { task: "Find the release date" },
    output: {
      entries,
      text: "It shipped in Mar",
      truncatedByTokenLimit: true,
    },
  } as unknown as ToolUIPart;
}

describe("SubAgentTool name resolution", () => {
  it("names the sub-agent from the tool input on a new delegation", () => {
    render(
      <SubAgentTool
        toolPart={
          {
            type: "tool-delegate",
            toolCallId: "call-1",
            state: "output-available",
            input: { subAgent: "Research Bot", task: "Find the release date" },
            output: { entries: [], text: "It shipped in March." },
          } as unknown as ToolUIPart
        }
      />,
    );

    expect(screen.getByText("Research Bot")).toBeInTheDocument();
  });

  it("un-mangles the tool name on a delegation stored before the single tool", () => {
    render(<SubAgentTool toolPart={delegateCall()} />);

    expect(screen.getByText("Research Bot")).toBeInTheDocument();
  });

  it("falls back to a generic label before the target has streamed in", () => {
    render(
      <SubAgentTool
        toolPart={
          {
            type: "tool-delegate",
            toolCallId: "call-1",
            state: "input-streaming",
            input: {},
          } as unknown as ToolUIPart
        }
      />,
    );

    expect(screen.getByText("Sub-Agent")).toBeInTheDocument();
  });
});

describe("SubAgentTool duration", () => {
  it("renders the recorded duration in the header", () => {
    render(<SubAgentTool toolPart={delegateCall({ durationMs: 42_000 })} />);

    expect(screen.getByText(/42\.0s/)).toBeInTheDocument();
  });

  it("renders no duration for a delegation recorded before timing existed", () => {
    render(<SubAgentTool toolPart={delegateCall()} />);

    expect(screen.getByText("Research Bot")).toBeInTheDocument();
    expect(screen.queryByText(/\d+(\.\d+)?(ms|s)/)).not.toBeInTheDocument();
  });
});

describe("SubAgentTool cut-short marker", () => {
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
    expect(
      screen.queryByText(SUB_AGENT_CUT_SHORT_NOTICE),
    ).not.toBeInTheDocument();
  });
});

describe("SubAgentTool step-limit marker", () => {
  const stepLimitedDelegateCall = (
    entries: Array<Record<string, unknown>> = [],
  ): ToolUIPart =>
    ({
      type: "tool-delegateToResearchBot",
      toolCallId: "call-1",
      state: "output-available",
      input: { task: "Find the release date" },
      output: {
        entries,
        text: "webFetch result: 404",
        stoppedAtStepLimit: true,
      },
    }) as unknown as ToolUIPart;

  const renderExpanded = (toolPart: ToolUIPart) => {
    render(<SubAgentTool toolPart={toolPart} />);
    fireEvent.click(screen.getByRole("button"));
  };

  it("marks a response whose loop was stopped short", () => {
    renderExpanded(stepLimitedDelegateCall());

    expect(screen.getByText(SUB_AGENT_STEP_LIMIT_NOTICE)).toBeInTheDocument();
  });

  it("marks it alongside an activity log too", () => {
    renderExpanded(
      stepLimitedDelegateCall([
        { type: "tool-call", toolName: "webFetch", status: "completed" },
      ]),
    );

    expect(screen.getByText(SUB_AGENT_STEP_LIMIT_NOTICE)).toBeInTheDocument();
  });

  it("names the step limit, not the output limit", () => {
    renderExpanded(stepLimitedDelegateCall());

    expect(
      screen.queryByText(SUB_AGENT_CUT_SHORT_NOTICE),
    ).not.toBeInTheDocument();
  });

  it("says nothing about a delegation that finished on its own", () => {
    renderExpanded(delegateCall());

    expect(
      screen.queryByText(SUB_AGENT_STEP_LIMIT_NOTICE),
    ).not.toBeInTheDocument();
  });
});

describe("SubAgentTool disclosure", () => {
  it("is collapsed until clicked and reports its status in the header", () => {
    render(<SubAgentTool toolPart={delegateCall()} />);

    const trigger = screen.getByRole("button", { name: /Research Bot/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByText("Task")).not.toBeInTheDocument();
    expect(screen.getByTestId("tool")).not.toHaveClass("border");

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.getByText("Find the release date")).toBeInTheDocument();
  });

  it("reports a delegation still streaming its activity as Running", () => {
    render(
      <SubAgentTool
        toolPart={
          {
            type: "tool-delegate",
            toolCallId: "call-1",
            state: "output-available",
            input: { subAgent: "Research Bot", task: "Find the release date" },
            output: {
              entries: [
                { type: "tool-call", toolName: "webFetch", status: "running" },
              ],
            },
          } as unknown as ToolUIPart
        }
      />,
    );

    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("keeps the delegation's own chevron independent of its nested transcript", () => {
    render(<SubAgentTool toolPart={delegateCall()} />);
    const trigger = screen.getByRole("button", { name: /Research Bot/ });

    expect(within(trigger).getByTestId("tool-chevron")).not.toHaveClass(
      "rotate-180",
    );
    fireEvent.click(trigger);
    expect(within(trigger).getByTestId("tool-chevron")).toHaveClass(
      "rotate-180",
    );
  });
});
