import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TurnAnnouncer } from "./turn-announcer";

function status() {
  return screen.getByRole("status");
}

describe("TurnAnnouncer", () => {
  it("says nothing before a turn has run", () => {
    render(<TurnAnnouncer status="ready" />);

    expect(status()).toHaveTextContent("");
    expect(status()).toHaveClass("sr-only");
  });

  it("says nothing while the reply streams", () => {
    const { rerender } = render(<TurnAnnouncer status="ready" />);
    rerender(<TurnAnnouncer status="submitted" />);
    rerender(<TurnAnnouncer status="streaming" />);

    expect(status()).toHaveTextContent("");
  });

  it("announces once the reply is complete", () => {
    const { rerender } = render(<TurnAnnouncer status="streaming" />);
    rerender(<TurnAnnouncer status="ready" />);

    expect(status()).toHaveTextContent("Reply complete.");
  });

  it("announces a failed reply", () => {
    const { rerender } = render(<TurnAnnouncer status="streaming" />);
    rerender(<TurnAnnouncer status="error" />);

    expect(status()).toHaveTextContent("The reply failed.");
  });

  it("clears the last announcement when the next turn starts", () => {
    const { rerender } = render(<TurnAnnouncer status="streaming" />);
    rerender(<TurnAnnouncer status="ready" />);
    rerender(<TurnAnnouncer status="submitted" />);

    expect(status()).toHaveTextContent("");
  });
});
