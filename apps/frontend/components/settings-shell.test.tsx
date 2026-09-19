import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";

beforeAll(() => {
  // jsdom has no matchMedia; SidebarProvider subscribes to it via useIsMobile.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
});

vi.mock("@/components/header", () => ({
  Header: ({ leftContent }: { leftContent?: React.ReactNode }) => (
    <header data-testid="header">{leftContent}</header>
  ),
}));

import { SettingsShell, SettingsColumns } from "./settings-shell";

describe("SettingsColumns", () => {
  it("renders the menu and the content", () => {
    render(
      <SettingsColumns menu={<nav>menu</nav>}>
        <p>content</p>
      </SettingsColumns>,
    );

    expect(screen.getByText("menu")).toBeInTheDocument();
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("maps the wide column and menu widths", () => {
    const { container } = render(
      <SettingsColumns menu={<nav />} columnWidth="wide" menuWidth="wide">
        <p>content</p>
      </SettingsColumns>,
    );

    expect(container.querySelector(".max-w-5xl")).toBeInTheDocument();
    expect(container.querySelector(".md\\:w-64")).toBeInTheDocument();
    expect(container.querySelector(".md\\:ml-64")).toBeInTheDocument();
  });

  it("maps the narrow column and menu widths", () => {
    const { container } = render(
      <SettingsColumns menu={<nav />} columnWidth="narrow">
        <p>content</p>
      </SettingsColumns>,
    );

    expect(container.querySelector(".max-w-3xl")).toBeInTheDocument();
    expect(container.querySelector(".md\\:w-48")).toBeInTheDocument();
    expect(container.querySelector(".md\\:ml-48")).toBeInTheDocument();
  });
});

describe("SettingsShell", () => {
  it("renders the header chrome around the menu and content", () => {
    render(
      <SettingsShell headerLeft={<span>back</span>} menu={<nav>menu</nav>}>
        <p>content</p>
      </SettingsShell>,
    );

    expect(screen.getByTestId("header")).toBeInTheDocument();
    expect(screen.getByText("back")).toBeInTheDocument();
    expect(screen.getByText("menu")).toBeInTheDocument();
    expect(screen.getByText("content")).toBeInTheDocument();
  });
});
