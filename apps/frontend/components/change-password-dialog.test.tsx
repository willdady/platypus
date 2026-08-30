import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChangePasswordDialog } from "./change-password-dialog";

vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "http://localhost:3000",
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("ChangePasswordDialog revealable input", () => {
  const dummyUser = {
    id: "user-123",
    email: "alice@example.com",
    name: "Alice",
  };

  it("defaults new password input to type='password'", () => {
    render(
      <ChangePasswordDialog
        user={dummyUser}
        open={true}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("New Password");
    expect(input).toHaveAttribute("type", "password");
    expect(
      screen.getByRole("button", { name: "Show new password" }),
    ).toBeInTheDocument();
  });

  it("toggles new password input between masked and revealed", () => {
    render(
      <ChangePasswordDialog
        user={dummyUser}
        open={true}
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("New Password");
    const toggleButton = screen.getByRole("button", {
      name: "Show new password",
    });

    fireEvent.click(toggleButton);
    expect(input).toHaveAttribute("type", "text");
    expect(
      screen.getByRole("button", { name: "Hide new password" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide new password" }));
    expect(input).toHaveAttribute("type", "password");
    expect(
      screen.getByRole("button", { name: "Show new password" }),
    ).toBeInTheDocument();
  });
});
