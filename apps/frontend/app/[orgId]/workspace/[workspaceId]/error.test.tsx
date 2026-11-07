import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ pathname: "/org1/workspace/ws1" }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1", workspaceId: "ws1" }),
  usePathname: () => nav.pathname,
}));

vi.mock("@/components/app-sidebar", () => ({
  AppSidebar: () => <nav data-testid="app-sidebar" />,
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

vi.mock("@/components/back-button", () => ({
  BackButton: ({ fallbackHref }: { fallbackHref?: string }) => (
    <button aria-label="Back" data-fallback-href={fallbackHref} />
  ),
}));

import WorkspacePageError from "./error";

function renderError() {
  render(<WorkspacePageError error={new Error("boom")} retry={vi.fn()} />);
}

afterEach(() => {
  nav.pathname = "/org1/workspace/ws1";
});

describe("WorkspacePageError", () => {
  it.each(["/org1/workspace/ws1", "/org1/workspace/ws1/chat/chat1"])(
    "draws the app sidebar and the Workspace home on %s",
    (pathname) => {
      nav.pathname = pathname;

      renderError();

      expect(screen.getByTestId("app-sidebar")).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "Workspace home" }),
      ).toHaveAttribute("href", "/org1/workspace/ws1");
    },
  );

  it("draws the plain shell on a route that has no sidebar", () => {
    nav.pathname = "/org1/workspace/ws1/agents/agent1";

    renderError();

    expect(screen.queryByTestId("app-sidebar")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Workspace home" }),
    ).toHaveAttribute("href", "/org1/workspace/ws1");
  });
});
