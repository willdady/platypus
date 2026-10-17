import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { setErrorReporter } from "@/lib/error-reporting";
import { MessagePartBoundary } from "./message-part-boundary";

afterEach(() => setErrorReporter(null));

function failWith(message: string) {
  return () => {
    throw new Error(message);
  };
}

describe("MessagePartBoundary", () => {
  it("reports a part that stays broken while it streams only once", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reporter = vi.fn();
    setErrorReporter(reporter);

    const { rerender } = render(
      <MessagePartBoundary render={failWith("bad input")} resetKey={1} />,
    );
    rerender(
      <MessagePartBoundary render={failWith("bad input")} resetKey={2} />,
    );
    rerender(
      <MessagePartBoundary render={failWith("bad input")} resetKey={3} />,
    );

    expect(screen.getByText("Couldn't render this part")).toBeInTheDocument();
    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it("reports a different failure in the same part", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reporter = vi.fn();
    setErrorReporter(reporter);

    const { rerender } = render(
      <MessagePartBoundary render={failWith("bad input")} resetKey={1} />,
    );
    rerender(
      <MessagePartBoundary render={failWith("bad output")} resetKey={2} />,
    );

    expect(reporter).toHaveBeenCalledTimes(2);
  });

  it("renders the part once it streams on whole", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { rerender } = render(
      <MessagePartBoundary render={failWith("bad input")} resetKey={1} />,
    );
    rerender(<MessagePartBoundary render={() => "Done"} resetKey={2} />);

    expect(screen.getByText("Done")).toBeInTheDocument();
  });
});
