import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ResponseMetricsPopover } from "./response-metrics-popover";

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
