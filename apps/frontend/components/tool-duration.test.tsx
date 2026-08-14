import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolDuration } from "./tool-duration";

describe("ToolDuration", () => {
  it("renders the recorded duration", () => {
    render(<ToolDuration durationMs={1234} />);

    expect(screen.getByText(/1\.2s/)).toBeInTheDocument();
  });

  it("renders nothing for a tool call with no recorded duration", () => {
    const { container } = render(<ToolDuration />);

    expect(container).toBeEmptyDOMElement();
  });

  // A recorded duration always shows, however small — only an absent one is
  // blank. Zero is a real measurement, not missing data.
  it.each([
    [842, /842ms/],
    [0, /<1ms/],
  ])("renders a %dms call", (durationMs, expected) => {
    render(<ToolDuration durationMs={durationMs} />);

    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});
