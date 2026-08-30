import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChangePasswordForm } from "./change-password-form";

const mockChangePassword = vi.fn();

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    authClient: {
      changePassword: mockChangePassword,
    },
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("ChangePasswordForm revealable inputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults all three password fields to masked type='password'", () => {
    render(<ChangePasswordForm />);

    const currentPassword = screen.getByLabelText("Current Password");
    const newPassword = screen.getByLabelText("New Password");
    const confirmPassword = screen.getByLabelText("Confirm New Password");

    expect(currentPassword).toHaveAttribute("type", "password");
    expect(newPassword).toHaveAttribute("type", "password");
    expect(confirmPassword).toHaveAttribute("type", "password");

    expect(
      screen.getByRole("button", { name: "Show current password" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show new password" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show confirm new password" }),
    ).toBeInTheDocument();
  });

  it("revealing Current Password leaves the other two masked", () => {
    render(<ChangePasswordForm />);

    const currentPassword = screen.getByLabelText("Current Password");
    const newPassword = screen.getByLabelText("New Password");
    const confirmPassword = screen.getByLabelText("Confirm New Password");

    fireEvent.click(
      screen.getByRole("button", { name: "Show current password" }),
    );

    expect(currentPassword).toHaveAttribute("type", "text");
    expect(newPassword).toHaveAttribute("type", "password");
    expect(confirmPassword).toHaveAttribute("type", "password");

    expect(
      screen.getByRole("button", { name: "Hide current password" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show new password" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show confirm new password" }),
    ).toBeInTheDocument();
  });

  it("toggles all fields independently", () => {
    render(<ChangePasswordForm />);

    const currentPassword = screen.getByLabelText("Current Password");
    const newPassword = screen.getByLabelText("New Password");
    const confirmPassword = screen.getByLabelText("Confirm New Password");

    // Reveal New Password
    fireEvent.click(screen.getByRole("button", { name: "Show new password" }));
    expect(currentPassword).toHaveAttribute("type", "password");
    expect(newPassword).toHaveAttribute("type", "text");
    expect(confirmPassword).toHaveAttribute("type", "password");

    // Reveal Confirm New Password
    fireEvent.click(
      screen.getByRole("button", { name: "Show confirm new password" }),
    );
    expect(currentPassword).toHaveAttribute("type", "password");
    expect(newPassword).toHaveAttribute("type", "text");
    expect(confirmPassword).toHaveAttribute("type", "text");

    // Conceal New Password
    fireEvent.click(screen.getByRole("button", { name: "Hide new password" }));
    expect(currentPassword).toHaveAttribute("type", "password");
    expect(newPassword).toHaveAttribute("type", "password");
    expect(confirmPassword).toHaveAttribute("type", "text");
  });
});
