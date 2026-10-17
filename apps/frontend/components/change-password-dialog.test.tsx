import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { ChangePasswordDialog } from "./change-password-dialog";

const { setUserPassword } = vi.hoisted(() => ({ setUserPassword: vi.fn() }));

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://localhost:3000",
  useAuth: () => ({
    user: null,
    isPending: false,
    authClient: { admin: { setUserPassword } },
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const alice = {
  id: "user-123",
  email: "alice@example.com",
  name: "Alice",
};

const renderDialog = () => {
  const onSuccess = vi.fn();
  render(
    <ChangePasswordDialog
      user={alice}
      open={true}
      onOpenChange={vi.fn()}
      onSuccess={onSuccess}
    />,
  );
  return { onSuccess, input: screen.getByLabelText("New Password") };
};

const submit = () =>
  fireEvent.click(screen.getByRole("button", { name: "Update password" }));

describe("ChangePasswordDialog", () => {
  it("masks the new password until revealed", () => {
    const { input } = renderDialog();

    expect(input).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Show new password" }));
    expect(input).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Hide new password" }));
    expect(input).toHaveAttribute("type", "password");
  });

  it("shows the server's length refusal on the field", async () => {
    setUserPassword.mockResolvedValue({
      error: { status: 400, message: "Password too short" },
    });
    const { input, onSuccess } = renderDialog();

    fireEvent.change(input, { target: { value: "1234567" } });
    submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Password too short",
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("sets the user's password and reports success", async () => {
    setUserPassword.mockResolvedValue({ error: null });
    const { input, onSuccess } = renderDialog();

    fireEvent.change(input, { target: { value: "12345678" } });
    submit();

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith(
      "Password updated successfully for Alice",
    );
    expect(setUserPassword).toHaveBeenCalledWith({
      userId: "user-123",
      newPassword: "12345678",
    });
    expect(input).toHaveValue("");
  });

  it("surfaces the backend's reason and stays open on a refusal", async () => {
    setUserPassword.mockResolvedValue({
      error: { status: 403, message: "Not allowed" },
    });
    const { input, onSuccess } = renderDialog();

    fireEvent.change(input, { target: { value: "12345678" } });
    submit();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Not allowed"),
    );
    expect(onSuccess).not.toHaveBeenCalled();
    expect(input).toHaveValue("12345678");
  });
});
