import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/app-sidebar", () => ({
  AppSidebar: () => <nav data-testid="app-sidebar" />,
}));
vi.mock("@/components/command-menu", () => ({ CommandMenu: () => null }));
vi.mock("@/components/workspace-switcher", () => ({
  WorkspaceSwitcher: () => <div data-testid="workspace-switcher" />,
}));
vi.mock("@/components/workspace-scroll-container", () => ({
  WorkspaceScrollContainer: ({ children }: { children: React.ReactNode }) =>
    children,
}));
vi.mock("@/components/header", () => ({
  Header: ({
    leftContent,
    bordered = true,
  }: {
    leftContent?: React.ReactNode;
    bordered?: boolean;
  }) => (
    <header data-testid="header" data-bordered={bordered}>
      {leftContent}
    </header>
  ),
}));

import SidebarLayout from "./(sidebar)/layout";
import PlainLayout from "./(plain)/layout";

const params = Promise.resolve({ orgId: "org1", workspaceId: "ws1" });

describe("Workspace (sidebar) layout", () => {
  it("draws the app sidebar and its trigger above an unbordered header", async () => {
    render(await SidebarLayout({ children: <p>page</p>, params }));

    expect(screen.getByTestId("app-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-switcher")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Toggle sidebar" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("header")).toHaveAttribute(
      "data-bordered",
      "false",
    );
    expect(screen.getByText("page")).toBeInTheDocument();
  });
});

describe("Workspace (plain) layout", () => {
  it("draws no sidebar; the bordered header holds Back and the switcher", async () => {
    render(await PlainLayout({ children: <p>page</p>, params }));

    expect(screen.queryByTestId("app-sidebar")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Toggle sidebar" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("header")).toHaveAttribute(
      "data-bordered",
      "true",
    );
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByTestId("workspace-switcher")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Workspace home" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("page")).toBeInTheDocument();
  });
});
