import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

/** The pathname the shell reads, which each test sets before rendering. */
const path = { current: "/org1/workspace/ws1" };

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => path.current,
}));
vi.mock("@/components/back-button", () => ({
  BackButton: ({ fallbackHref }: { fallbackHref?: string }) => (
    <button aria-label="Back" data-fallback-href={fallbackHref} />
  ),
}));
vi.mock("@/components/user-menu", () => ({ UserMenu: () => null }));
vi.mock("@/components/mode-toggle", () => ({ ModeToggle: () => null }));
vi.mock("@/components/notifications-dropdown", () => ({
  NotificationsDropdown: () => null,
}));

import { WorkspaceShell } from "./workspace-shell";

beforeEach(() => {
  path.current = "/org1/workspace/ws1";
});

describe("WorkspaceShell", () => {
  it("links the Workspace home from the header", () => {
    render(
      <WorkspaceShell orgId="org1" workspaceId="ws1">
        content
      </WorkspaceShell>,
    );

    expect(
      screen.getByRole("link", { name: "Workspace home" }),
    ).toHaveAttribute("href", "/org1/workspace/ws1");
  });

  it("links the Organization home when there is no Workspace", () => {
    render(<WorkspaceShell orgId="org1">content</WorkspaceShell>);

    expect(
      screen.getByRole("link", { name: "Organization home" }),
    ).toHaveAttribute("href", "/org1");
  });

  it.each([
    ["a Board", "/org1/workspace/ws1/boards/b1"],
    ["a Board's settings", "/org1/workspace/ws1/boards/b1/settings"],
    ["the create form", "/org1/workspace/ws1/boards/create"],
  ])("sends the Back fallback from %s to the Boards list", (_, pathname) => {
    path.current = pathname;
    render(
      <WorkspaceShell orgId="org1" workspaceId="ws1">
        content
      </WorkspaceShell>,
    );

    expect(screen.getByRole("button", { name: "Back" })).toHaveAttribute(
      "data-fallback-href",
      "/org1/workspace/ws1/boards",
    );
  });

  it.each([
    ["an Agent", "/org1/workspace/ws1/agents/a1"],
    ["settings", "/org1/workspace/ws1/settings"],
    ["the Artifacts list", "/org1/workspace/ws1/artifacts"],
  ])("sends the Back fallback from %s to the Workspace home", (_, pathname) => {
    path.current = pathname;
    render(
      <WorkspaceShell orgId="org1" workspaceId="ws1">
        content
      </WorkspaceShell>,
    );

    expect(screen.getByRole("button", { name: "Back" })).toHaveAttribute(
      "data-fallback-href",
      "/org1/workspace/ws1",
    );
  });
});
