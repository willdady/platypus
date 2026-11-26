import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ResourcePage } from "./resource-page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

describe("ResourcePage", () => {
  it("renders the back button, title, and children", () => {
    render(
      <ResourcePage backFallbackHref="/somewhere" title="Create Thing">
        <div>form goes here</div>
      </ResourcePage>,
    );

    expect(screen.getByRole("button", { name: /Back/ })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Create Thing" }),
    ).toBeInTheDocument();
    expect(screen.getByText("form goes here")).toBeInTheDocument();
  });

  it("defaults to the bare variant with no outer centering wrapper", () => {
    render(
      <ResourcePage backFallbackHref="/somewhere" title="Title">
        <div>content</div>
      </ResourcePage>,
    );

    expect(screen.getByTestId("resource-page")).not.toHaveClass("flex");
  });

  it("applies the narrow variant's centered column and mb-4 title spacing", () => {
    render(
      <ResourcePage
        backFallbackHref="/somewhere"
        title="Create Thing"
        variant="narrow"
      >
        <div>content</div>
      </ResourcePage>,
    );

    const heading = screen.getByRole("heading", { name: "Create Thing" });
    expect(heading).toHaveClass("mb-4");
  });

  it("applies the stacked variant's spacing without a title mb-4", () => {
    render(
      <ResourcePage
        backFallbackHref="/somewhere"
        title="Settings"
        variant="stacked"
      >
        <div>content</div>
      </ResourcePage>,
    );

    const heading = screen.getByRole("heading", { name: "Settings" });
    expect(heading).not.toHaveClass("mb-4");
  });

  it("applies the wide variant's w-lg column", () => {
    render(
      <ResourcePage backFallbackHref="/somewhere" title="Title" variant="wide">
        <div>content</div>
      </ResourcePage>,
    );

    expect(screen.getByTestId("resource-page")).toHaveClass("w-lg");
  });

  it("renders the actions beside the title", () => {
    render(
      <ResourcePage
        backFallbackHref="/somewhere"
        title="Edit Thing"
        actions={<button>View runs</button>}
      >
        <div>content</div>
      </ResourcePage>,
    );

    const header = screen.getByTestId("page-header");
    expect(
      within(header).getByRole("heading", { name: "Edit Thing" }),
    ).toBeInTheDocument();
    expect(
      within(header).getByRole("button", { name: "View runs" }),
    ).toBeInTheDocument();
  });

  it("leaves the title on its own without actions", () => {
    render(
      <ResourcePage backFallbackHref="/somewhere" title="Edit Thing">
        <div>content</div>
      </ResourcePage>,
    );

    const heading = screen.getByRole("heading", { name: "Edit Thing" });
    const back = screen.getByRole("button", { name: /Back/ });
    expect(
      back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByTestId("page-header")).not.toBeInTheDocument();
  });
});
