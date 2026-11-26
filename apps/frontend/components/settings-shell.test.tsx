import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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
    render(
      <SettingsColumns menu={<nav />} columnWidth="wide" menuWidth="wide">
        <p>content</p>
      </SettingsColumns>,
    );

    expect(screen.getByTestId("settings-columns")).toHaveClass("max-w-5xl");
    expect(screen.getByTestId("settings-menu")).toHaveClass("md:w-64");
    expect(screen.getByTestId("settings-content")).toHaveClass("md:ml-64");
  });

  it("maps the narrow column and menu widths", () => {
    render(
      <SettingsColumns menu={<nav />} columnWidth="narrow">
        <p>content</p>
      </SettingsColumns>,
    );

    expect(screen.getByTestId("settings-columns")).toHaveClass("max-w-3xl");
    expect(screen.getByTestId("settings-menu")).toHaveClass("md:w-48");
    expect(screen.getByTestId("settings-content")).toHaveClass("md:ml-48");
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
