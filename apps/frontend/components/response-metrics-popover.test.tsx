import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  ResponseMetricsPopover,
  responseMetrics,
} from "./response-metrics-popover";

describe("ResponseMetricsPopover", () => {
  it("renders no control when the message carries no metric at all", () => {
    const { container } = render(
      <ResponseMetricsPopover metadata={{ agentId: "agent-1" }} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders no control for a message with no metadata", () => {
    const { container } = render(
      <ResponseMetricsPopover metadata={undefined} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("opens the panel on click, not merely on hover", async () => {
    render(
      <ResponseMetricsPopover
        metadata={{
          tokenUsage: { inputTokens: 5_200, outputTokens: 100 },
        }}
      />,
    );

    expect(screen.queryByText("Input")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Response metrics" }));

    expect(await screen.findByText("Input")).toBeInTheDocument();
  });

  it("shows Input, Output and Total, with Total equal to their sum", async () => {
    render(
      <ResponseMetricsPopover
        metadata={{
          tokenUsage: { inputTokens: 5_200, outputTokens: 100 },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Response metrics" }));

    expect(await screen.findByText("5,200")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("5,300")).toBeInTheDocument();
  });

  it("shows the cached-input breakdown under Input (issue #734)", async () => {
    render(
      <ResponseMetricsPopover
        metadata={{
          tokenUsage: {
            inputTokens: 5_200,
            outputTokens: 100,
            cacheReadTokens: 2_700,
            cacheWriteTokens: 150,
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Response metrics" }));

    expect(
      await screen.findByText("of which 2,700 read from cache"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("of which 150 written to cache"),
    ).toBeInTheDocument();
  });

  it("renders the read breakdown without a write one when the Provider reports no write", async () => {
    render(
      <ResponseMetricsPopover
        metadata={{
          tokenUsage: {
            inputTokens: 5_200,
            outputTokens: 100,
            cacheReadTokens: 900,
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Response metrics" }));

    expect(
      await screen.findByText("of which 900 read from cache"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/written to cache/)).not.toBeInTheDocument();
  });

  it("keeps Input, Output and Total unchanged when cache details are present", async () => {
    render(
      <ResponseMetricsPopover
        metadata={{
          tokenUsage: {
            inputTokens: 5_200,
            outputTokens: 100,
            cacheReadTokens: 2_700,
            cacheWriteTokens: 150,
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Response metrics" }));

    await screen.findByText("5,200");
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("5,300")).toBeInTheDocument();
  });

  it("shows Preparation and Model, formatted by the shared duration formatter", async () => {
    render(
      <ResponseMetricsPopover
        metadata={{ prepDurationMs: 842, modelDurationMs: 12_345 }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Response metrics" }));

    expect(await screen.findByText("842ms")).toBeInTheDocument();
    expect(screen.getByText("12.3s")).toBeInTheDocument();
  });

  it("nests measured tool time under Model, labelled as measured", async () => {
    render(
      <ResponseMetricsPopover
        metadata={{
          modelDurationMs: 12_000,
          toolDurations: { "call-1": 300, "call-2": 700 },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Response metrics" }));

    expect(
      await screen.findByText(/of which tools 1\.0s measured/),
    ).toBeInTheDocument();
  });

  it("omits the tool-time line when the turn ran no local tools", async () => {
    render(<ResponseMetricsPopover metadata={{ modelDurationMs: 12_000 }} />);

    fireEvent.click(screen.getByRole("button", { name: "Response metrics" }));

    await screen.findByText("Model");
    expect(screen.queryByText(/of which tools/)).not.toBeInTheDocument();
  });

  // `0` is a real measurement — a tool that finished inside a millisecond — not
  // an absent one, so the line is shown.
  it("keeps a zero measured tool duration rather than treating it as absent", async () => {
    render(
      <ResponseMetricsPopover
        metadata={{
          modelDurationMs: 12_000,
          toolDurations: { "call-1": 0 },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Response metrics" }));

    expect(
      await screen.findByText(/of which tools <1ms measured/),
    ).toBeInTheDocument();
  });

  it("omits fields with no data rather than rendering a placeholder", async () => {
    render(
      <ResponseMetricsPopover
        metadata={{ tokenUsage: { inputTokens: 1_000, outputTokens: 30 } }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Response metrics" }));

    await screen.findByText("Input");
    expect(screen.queryByText("Preparation")).not.toBeInTheDocument();
    expect(screen.queryByText("Model")).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("shows only the measured tool line for a legacy message with no phase durations", async () => {
    render(
      <ResponseMetricsPopover
        metadata={{ toolDurations: { "call-1": 842 } }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Response metrics" }));

    expect(
      await screen.findByText(/of which tools 842ms measured/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Model")).not.toBeInTheDocument();
  });
});

// The panel's body reads only the metrics it is handed. The pure reader is
// unit-tested here so the rendering tests above can stay about rendering.
describe("responseMetrics", () => {
  it("returns undefined for a message with no metadata at all", () => {
    expect(responseMetrics(undefined)).toBeUndefined();
  });

  it("returns undefined when metadata carries none of the panel's fields", () => {
    expect(responseMetrics({ agentId: "agent-1" })).toBeUndefined();
  });

  it("reads Token usage, Preparation and Model straight off metadata", () => {
    expect(
      responseMetrics({
        tokenUsage: { inputTokens: 5_200, outputTokens: 100 },
        prepDurationMs: 842,
        modelDurationMs: 12_000,
      }),
    ).toEqual({
      tokenUsage: { inputTokens: 5_200, outputTokens: 100 },
      prepDurationMs: 842,
      modelDurationMs: 12_000,
      measuredToolDurationMs: undefined,
    });
  });

  it("passes the cached-input breakdown through with Token usage (issue #734)", () => {
    expect(
      responseMetrics({
        tokenUsage: {
          inputTokens: 5_200,
          outputTokens: 100,
          cacheReadTokens: 2_700,
          cacheWriteTokens: 150,
        },
      }),
    ).toEqual({
      tokenUsage: {
        inputTokens: 5_200,
        outputTokens: 100,
        cacheReadTokens: 2_700,
        cacheWriteTokens: 150,
      },
      prepDurationMs: undefined,
      modelDurationMs: undefined,
      measuredToolDurationMs: undefined,
    });
  });

  it("sums measured tool durations across every tool call", () => {
    const metrics = responseMetrics({
      modelDurationMs: 12_000,
      toolDurations: { "call-1": 300, "call-2": 700 },
    });

    expect(metrics?.measuredToolDurationMs).toBe(1_000);
  });

  it("keeps a zero measured tool duration rather than treating it as absent", () => {
    const metrics = responseMetrics({
      modelDurationMs: 12_000,
      toolDurations: { "call-1": 0 },
    });

    expect(metrics?.measuredToolDurationMs).toBe(0);
  });

  it("says nothing about tool time when the turn ran no local tools", () => {
    const metrics = responseMetrics({ modelDurationMs: 12_000 });

    expect(metrics?.measuredToolDurationMs).toBeUndefined();
  });

  it("shows an (i) for a message that carries only measured tool time", () => {
    // The legacy case: a message persisted before this change, which carries
    // #353's tool durations but neither Token usage nor a phase duration.
    const metrics = responseMetrics({
      toolDurations: { "call-1": 842 },
    });

    expect(metrics).toEqual({
      tokenUsage: undefined,
      prepDurationMs: undefined,
      modelDurationMs: undefined,
      measuredToolDurationMs: 842,
    });
  });
});
