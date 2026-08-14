import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { ContextMeter } from "./context-meter";

describe("ContextMeter", () => {
  it("renders nothing when no Context window is declared", () => {
    const { container } = render(<ContextMeter occupancy={42_000} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when occupancy is unknown", () => {
    // Absent and null say the same thing — the Provider reported no usage for
    // the last call of the turn — and neither is a number a reader could
    // interpret without a denominator.
    for (const occupancy of [undefined, null]) {
      const { container } = render(
        <ContextMeter occupancy={occupancy} contextWindow={128_000} />,
      );
      expect(container).toBeEmptyDOMElement();
    }
  });

  it("shows the percentage and both token figures", () => {
    render(<ContextMeter occupancy={42_000} contextWindow={128_000} />);

    // Both numbers, not only a bar: 33% of 128k and 33% of 8k are different
    // situations and a bar alone cannot tell them apart.
    expect(screen.getByText(/42,000/)).toBeInTheDocument();
    expect(screen.getByText(/128,000/)).toBeInTheDocument();
    expect(screen.getByText(/33%/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "33",
    );
  });

  it("clamps the bar and the percentage but not the figures when occupancy exceeds the window", () => {
    // Under-declaring is the safe direction and therefore expected, so a
    // deliberately conservative window must not make the meter look broken.
    render(<ContextMeter occupancy={150_000} contextWindow={128_000} />);

    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    expect(screen.getByText(/100%/)).toBeInTheDocument();
    expect(screen.queryByText(/117%/)).not.toBeInTheDocument();
    expect(screen.getByText(/150,000/)).toBeInTheDocument();
    expect(screen.getByText(/128,000/)).toBeInTheDocument();
  });

  it("rounds a nearly-empty window to a percentage rather than hiding", () => {
    render(<ContextMeter occupancy={12} contextWindow={128_000} />);

    expect(screen.getByText(/0%/)).toBeInTheDocument();
    expect(screen.getByText(/12/)).toBeInTheDocument();
  });
});
