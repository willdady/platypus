import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

  it("defaults to the plain variant with no outer centering wrapper", () => {
    const { container } = render(
      <ResourcePage backFallbackHref="/somewhere" title="Title">
        <div>content</div>
      </ResourcePage>,
    );

    expect(container.firstChild).not.toHaveClass("flex");
  });

  it("applies the create variant's centered column and mb-4 title spacing", () => {
    render(
      <ResourcePage
        backFallbackHref="/somewhere"
        title="Create Thing"
        variant="create"
      >
        <div>content</div>
      </ResourcePage>,
    );

    const heading = screen.getByRole("heading", { name: "Create Thing" });
    expect(heading).toHaveClass("mb-4");
  });

  it("applies the settings variant's spacing without a title mb-4", () => {
    render(
      <ResourcePage
        backFallbackHref="/somewhere"
        title="Settings"
        variant="settings"
      >
        <div>content</div>
      </ResourcePage>,
    );

    const heading = screen.getByRole("heading", { name: "Settings" });
    expect(heading).not.toHaveClass("mb-4");
  });

  it("applies the wide variant's w-lg column", () => {
    const { container } = render(
      <ResourcePage backFallbackHref="/somewhere" title="Title" variant="wide">
        <div>content</div>
      </ResourcePage>,
    );

    expect(container.querySelector(".w-lg")).toBeInTheDocument();
  });
});
