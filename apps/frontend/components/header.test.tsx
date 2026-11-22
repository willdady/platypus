import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Header } from "@/components/header";

vi.mock("@/components/user-menu", () => ({ UserMenu: () => null }));
vi.mock("@/components/mode-toggle", () => ({ ModeToggle: () => null }));
vi.mock("@/components/notifications-dropdown", () => ({
  NotificationsDropdown: () => null,
}));

describe("Header", () => {
  it("leaves Workspace settings to the rail", () => {
    render(<Header scope={{ orgId: "org1", workspaceId: "ws1" }} />);
    expect(
      screen.queryByRole("button", { name: "Workspace settings" }),
    ).not.toBeInTheDocument();
  });

  it("has no Workspace settings menu outside a Workspace", () => {
    render(<Header scope={{ orgId: "org1" }} />);
    expect(
      screen.queryByRole("button", { name: "Workspace settings" }),
    ).not.toBeInTheDocument();
  });
});
