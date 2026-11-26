import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthShell } from "./auth-shell";

describe("AuthShell", () => {
  it("renders its children inside the main landmark the skip link targets", () => {
    render(
      <AuthShell>
        <p>content</p>
      </AuthShell>,
    );

    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("renders a title as the page heading", () => {
    render(<AuthShell title="Sign in to Platypus" />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Sign in to Platypus" }),
    ).toBeInTheDocument();
  });

  it("renders a rich description with the title", () => {
    render(
      <AuthShell
        title="You're invited"
        description={
          <>
            Join <span className="font-bold">Acme</span>.
          </>
        }
      />,
    );

    expect(screen.getByText("Join", { exact: false })).toHaveTextContent(
      "Join Acme.",
    );
  });

  it("renders no heading when there is no title", () => {
    render(
      <AuthShell>
        <p>content</p>
      </AuthShell>,
    );

    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});
