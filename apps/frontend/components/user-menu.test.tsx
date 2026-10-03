import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// --- Module mocks ------------------------------------------------------------

const { authState } = vi.hoisted(() => ({
  authState: {
    user: null as {
      id: string;
      name: string;
      email: string;
      role?: string;
    } | null,
    isPending: false,
    authClient: { signOut: () => Promise.resolve() },
  },
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => authState,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { UserMenu } from "./user-menu";

// --- Tests -------------------------------------------------------------------

beforeEach(() => {
  authState.user = null;
  authState.isPending = false;
});

describe("UserMenu", () => {
  it("holds the trigger's slot while the session resolves", () => {
    authState.isPending = true;
    render(<UserMenu />);

    const placeholder = screen.getByRole("status", {
      name: "Loading account",
    });
    expect(placeholder).toHaveClass("size-7");
  });

  it("renders nothing once the reader is known to be signed out", () => {
    const { container } = render(<UserMenu />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders the menu trigger for a signed-in reader", () => {
    authState.user = { id: "u1", name: "Ada", email: "ada@example.com" };
    render(<UserMenu />);

    expect(screen.getByRole("button")).toHaveClass("size-7");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  const openMenu = () => {
    const trigger = screen.getByRole("button", { name: "Account menu" });
    fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
    fireEvent.click(trigger, { button: 0 });
  };

  it("links to each settings page, without Users for a non-admin", () => {
    authState.user = { id: "u1", name: "Ada", email: "ada@example.com" };
    render(<UserMenu />);
    openMenu();

    expect(screen.getByRole("menuitem", { name: "Contexts" })).toHaveAttribute(
      "href",
      "/settings/contexts",
    );
    expect(
      screen.queryByRole("menuitem", { name: "Users" }),
    ).not.toBeInTheDocument();
  });

  it("links to Users for a super-admin", () => {
    authState.user = {
      id: "u1",
      name: "Ada",
      email: "ada@example.com",
      role: "admin",
    };
    render(<UserMenu />);
    openMenu();

    expect(screen.getByRole("menuitem", { name: "Users" })).toHaveAttribute(
      "href",
      "/settings/users",
    );
  });
});
