import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RunEvent } from "@platypus/schemas";
import { activityColor, activityLabel } from "./activity-row";
import {
  RunTimeline,
  RUN_TIMELINE_EMPTY_NOTICE,
  RUN_TIMELINE_TRUNCATED_NOTICE,
  UNKNOWN_DURATION_LABEL,
} from "./run-timeline";

const T0 = 1_767_258_000_000;

function event(over: Partial<RunEvent> & { id: string }): RunEvent {
  return {
    runId: "run-1",
    parentEventId: null,
    seq: 0,
    type: "tool-call",
    toolName: "search",
    startedAt: T0,
    durationMs: 100,
    status: "completed",
    error: null,
    childrenTruncated: false,
    ...over,
  };
}

describe("RunTimeline", () => {
  it("renders one row per event, nested by parent, with its duration", () => {
    const { container } = render(
      <RunTimeline
        events={[
          event({
            id: "d",
            type: "delegate",
            toolName: "Researcher",
            durationMs: 900,
          }),
          event({
            id: "c",
            parentEventId: "d",
            seq: 1,
            startedAt: T0 + 10,
            toolName: "lookup",
            durationMs: 250,
          }),
          event({
            id: "t",
            type: "text",
            seq: 2,
            startedAt: T0 + 950,
            durationMs: 50,
          }),
        ]}
        runStatus="success"
      />,
    );

    expect(screen.getByText("Researcher")).toBeInTheDocument();
    expect(screen.getByText("lookup")).toBeInTheDocument();
    expect(screen.getByText("Generating response…")).toBeInTheDocument();
    expect(screen.getByText("250ms")).toBeInTheDocument();
    const depths = Array.from(container.querySelectorAll("li[data-depth]")).map(
      (li) => li.getAttribute("data-depth"),
    );
    expect(depths).toEqual(["0", "1", "0"]);
  });

  it("labels argument generation for its tool, in its own colour", () => {
    const { container } = render(
      <RunTimeline
        events={[
          event({ id: "i", type: "tool-input", toolName: "delegate" }),
          event({ id: "c", seq: 1, startedAt: T0 + 100 }),
        ]}
        runStatus="success"
      />,
    );

    expect(
      screen.getByText(
        activityLabel({
          type: "tool-input",
          toolName: "delegate",
          status: "completed",
        }),
      ),
    ).toBeInTheDocument();
    const [input, call] = Array.from(
      container.querySelectorAll<HTMLElement>('[role="img"]'),
    );
    expect(activityColor["tool-input"].bg).not.toBe(
      activityColor["tool-call"].bg,
    );
    expect(input.className).toContain(activityColor["tool-input"].bg);
    expect(call.className).toContain(activityColor["tool-call"].bg);
  });

  it("draws parallel tool calls as overlapping bars", () => {
    const { container } = render(
      <RunTimeline
        events={[
          event({ id: "a", toolName: "a", durationMs: 100 }),
          event({
            id: "b",
            seq: 1,
            toolName: "b",
            startedAt: T0 + 40,
            durationMs: 100,
          }),
        ]}
        runStatus="success"
      />,
    );

    const bars = Array.from(
      container.querySelectorAll<HTMLElement>('[role="img"]'),
    );
    expect(bars).toHaveLength(2);
    const [a, b] = bars.map((bar) => ({
      left: parseFloat(bar.style.left),
      width: parseFloat(bar.style.width),
    }));
    // b starts before a ends: the bars share horizontal ground.
    expect(b.left).toBeLessThan(a.left + a.width);
    expect(b.left).toBeGreaterThan(a.left);
  });

  it("gives a sub-millisecond span a visible minimum width", () => {
    const { container } = render(
      <RunTimeline
        events={[
          event({ id: "tiny", toolName: "tiny", durationMs: 0 }),
          event({ id: "long", seq: 1, toolName: "long", durationMs: 60_000 }),
        ]}
        runStatus="success"
      />,
    );

    const [tiny] = Array.from(
      container.querySelectorAll<HTMLElement>('[role="img"]'),
    );
    expect(parseFloat(tiny.style.width)).toBeGreaterThan(0);
    expect(tiny.className).toContain("min-w-");
  });

  it("says an open event under a terminal run has an unknown duration instead of drawing it to now", () => {
    const { container } = render(
      <RunTimeline
        events={[
          event({ id: "done", durationMs: 400 }),
          event({
            id: "open",
            seq: 1,
            toolName: "hung",
            startedAt: T0 + 100,
            durationMs: null,
            status: "error",
          }),
        ]}
        runStatus="failed"
        now={T0 + 500_000}
      />,
    );

    expect(screen.getByText(UNKNOWN_DURATION_LABEL)).toBeInTheDocument();
    // One real bar — the completed event's. The open one gets a marker only.
    expect(container.querySelectorAll('[role="img"]')).toHaveLength(1);
  });

  it("draws an open event under a running run to now", () => {
    const { container } = render(
      <RunTimeline
        events={[
          event({
            id: "live",
            toolName: "live",
            durationMs: null,
            status: "running",
          }),
        ]}
        runStatus="running"
        now={T0 + 3_000}
      />,
    );

    const [bar] = Array.from(
      container.querySelectorAll<HTMLElement>('[role="img"]'),
    );
    expect(bar.className).toContain("animate-pulse");
    expect(screen.queryByText(UNKNOWN_DURATION_LABEL)).not.toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("shows a failed event's error, marked when it was truncated", () => {
    render(
      <RunTimeline
        events={[
          event({
            id: "bad",
            status: "error",
            error: {
              message: "upstream 503",
              truncated: false,
              originalBytes: 12,
            },
          }),
          event({
            id: "clipped",
            seq: 1,
            startedAt: T0 + 200,
            status: "error",
            error: {
              message: "a very long",
              truncated: true,
              originalBytes: 5000,
            },
          }),
        ]}
        runStatus="failed"
      />,
    );

    expect(screen.getByText("upstream 503")).toBeInTheDocument();
    expect(screen.getByText("a very long… (truncated)")).toBeInTheDocument();
  });

  it("renders the empty notice for a run with no events", () => {
    render(<RunTimeline events={[]} runStatus="success" />);

    expect(screen.getByText(RUN_TIMELINE_EMPTY_NOTICE)).toBeInTheDocument();
  });

  it("marks a timeline cut at the event ceiling, on the run and on the node", () => {
    render(
      <RunTimeline
        events={[
          event({
            id: "d",
            type: "delegate",
            toolName: "Researcher",
            childrenTruncated: true,
          }),
        ]}
        runStatus="success"
        eventsTruncated
      />,
    );

    expect(screen.getByText(RUN_TIMELINE_TRUNCATED_NOTICE)).toBeInTheDocument();
    expect(
      screen.getByText("Later events beneath this one were not recorded."),
    ).toBeInTheDocument();
  });
});
