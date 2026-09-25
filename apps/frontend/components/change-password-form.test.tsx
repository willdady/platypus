import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { ChangePasswordForm } from "./change-password-form";

const mockChangePassword = vi.fn();

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    authClient: {
      changePassword: mockChangePassword,
    },
  }),
  useBackendUrl: () => "http://test",
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const fields = () => ({
  current: screen.getByLabelText("Current Password"),
  next: screen.getByLabelText("New Password"),
  confirm: screen.getByLabelText("Confirm New Password"),
});

const fill = (current: string, next: string, confirm: string) => {
  const f = fields();
  fireEvent.change(f.current, { target: { value: current } });
  fireEvent.change(f.next, { target: { value: next } });
  fireEvent.change(f.confirm, { target: { value: confirm } });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
};

beforeEach(() => {
  vi.clearAllMocks();
});

// Toggle independence is RevealableInput's own; here, only that each field is
// masked and its toggle is wired to it.
describe("ChangePasswordForm revealable inputs", () => {
  it.each([
    ["Show current password", "current"],
    ["Show new password", "next"],
    ["Show confirm new password", "confirm"],
  ] as const)(
    "masks all three fields; %s reveals only its own",
    (toggle, key) => {
      render(<ChangePasswordForm />);
      const all = fields();

      for (const input of Object.values(all)) {
        expect(input).toHaveAttribute("type", "password");
      }
      fireEvent.click(screen.getByRole("button", { name: toggle }));

      for (const [name, input] of Object.entries(all)) {
        expect(input).toHaveAttribute(
          "type",
          name === key ? "text" : "password",
        );
      }
    },
  );
});

describe("ChangePasswordForm submit", () => {
  it("refuses a confirmation that doesn't match, without calling the auth client", () => {
    render(<ChangePasswordForm />);

    fill("old-pass", "new-pass-1", "new-pass-2");

    expect(screen.getByText("Passwords do not match")).toBeInTheDocument();
    expect(fields().confirm).toHaveAttribute("aria-invalid", "true");
    expect(mockChangePassword).not.toHaveBeenCalled();
  });

  it("changes the password, signs other sessions out, and clears the form", async () => {
    mockChangePassword.mockResolvedValue({ error: null });
    render(<ChangePasswordForm />);

    fill("old-pass", "new-pass-1", "new-pass-1");

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Password changed successfully",
      ),
    );
    expect(mockChangePassword).toHaveBeenCalledWith({
      currentPassword: "old-pass",
      newPassword: "new-pass-1",
      revokeOtherSessions: true,
    });
    const { current, next, confirm } = fields();
    expect(current).toHaveValue("");
    expect(next).toHaveValue("");
    expect(confirm).toHaveValue("");
  });

  it("shows the auth client's reason and keeps what was typed", async () => {
    mockChangePassword.mockResolvedValue({
      error: { message: "Invalid password" },
    });
    render(<ChangePasswordForm />);

    fill("wrong-pass", "new-pass-1", "new-pass-1");

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Invalid password"),
    );
    expect(fields().current).toHaveValue("wrong-pass");
  });
});
