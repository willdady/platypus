import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Header } from "@/components/header";

vi.mock("@/components/user-menu", () => ({ UserMenu: () => null }));
vi.mock("@/components/mode-toggle", () => ({ ModeToggle: () => null }));
vi.mock("@/components/notifications-dropdown", () => ({
  NotificationsDropdown: () => null,
}));

describe("Header", () => {
  it("links to the Workspace's settings when scoped to a Workspace", () => {
    render(<Header scope={{ orgId: "org1", workspaceId: "ws1" }} />);
    expect(
      screen.getByRole("link", { name: "Workspace settings" }),
    ).toHaveAttribute("href", "/org1/workspace/ws1/settings");
  });

  it("has no Workspace settings link outside a Workspace", () => {
    render(<Header scope={{ orgId: "org1" }} />);
    expect(
      screen.queryByRole("link", { name: "Workspace settings" }),
    ).not.toBeInTheDocument();
  });
});
