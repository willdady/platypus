import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageHeader } from "./page-header";

describe("PageHeader", () => {
  it("renders the title as the page's h1", () => {
    render(<PageHeader title="Providers" />);

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Providers",
    });
    expect(heading).toHaveClass("text-2xl", "font-bold", "mb-4");
  });

  it("renders the description under the title", () => {
    render(
      <PageHeader
        title="Providers"
        description="Providers defined here are shared resources."
      />,
    );

    expect(
      screen.getByText("Providers defined here are shared resources."),
    ).toHaveClass("text-muted-foreground", "mb-6");
  });

  it("accepts a description that embeds live content", () => {
    render(
      <PageHeader
        title="Members"
        description={
          <>
            Manage members of <span>Acme</span>.
          </>
        }
      />,
    );

    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("renders actions beside the title", () => {
    render(
      <PageHeader title="Edit Trigger" actions={<button>View runs</button>} />,
    );

    const heading = screen.getByRole("heading", { level: 1 });
    const action = screen.getByRole("button", { name: "View runs" });
    expect(heading.compareDocumentPosition(action)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("drops the title's bottom margin where a parent column spaces it", () => {
    render(<PageHeader title="Board Settings" titleSpacing="flush" />);

    expect(screen.getByRole("heading", { level: 1 })).not.toHaveClass("mb-4");
  });
});
