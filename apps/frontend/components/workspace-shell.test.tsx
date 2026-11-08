import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
}));
vi.mock("@/components/user-menu", () => ({ UserMenu: () => null }));
vi.mock("@/components/mode-toggle", () => ({ ModeToggle: () => null }));
vi.mock("@/components/notifications-dropdown", () => ({
  NotificationsDropdown: () => null,
}));

import { WorkspaceShell } from "./workspace-shell";

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
});
