import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Header } from "@/components/header";

vi.mock("@/components/user-menu", () => ({ UserMenu: () => null }));
vi.mock("@/components/mode-toggle", () => ({ ModeToggle: () => null }));
vi.mock("@/components/notifications-dropdown", () => ({
  NotificationsDropdown: () => null,
}));

describe("Header", () => {
  it("opens a Workspace settings menu when scoped to a Workspace", () => {
    render(<Header scope={{ orgId: "org1", workspaceId: "ws1" }} />);
    const trigger = screen.getByRole("button", { name: "Workspace settings" });
    fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
    fireEvent.click(trigger, { button: 0 });
    expect(screen.getByRole("menuitem", { name: "Workspace" })).toHaveAttribute(
      "href",
      "/org1/workspace/ws1/settings",
    );
    expect(screen.getByRole("menuitem", { name: "Webhooks" })).toHaveAttribute(
      "href",
      "/org1/workspace/ws1/settings/webhooks",
    );
  });

  it("has no Workspace settings menu outside a Workspace", () => {
    render(<Header scope={{ orgId: "org1" }} />);
    expect(
      screen.queryByRole("button", { name: "Workspace settings" }),
    ).not.toBeInTheDocument();
  });
});
