import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { ChangePasswordDialog } from "./change-password-dialog";
import { jsonResponse } from "@/lib/test-utils";

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://localhost:3000",
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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChangePasswordDialog", () => {
  it("masks the new password until revealed", () => {
    const { input } = renderDialog();

    expect(input).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Show new password" }));
    expect(input).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Hide new password" }));
    expect(input).toHaveAttribute("type", "password");
  });

  it("rejects a password shorter than 8 characters without sending it", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { input } = renderDialog();

    fireEvent.change(input, { target: { value: "1234567" } });
    submit();

    expect(
      screen.getByText("Password must be at least 8 characters"),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets the user's password and reports success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    const { input, onSuccess } = renderDialog();

    fireEvent.change(input, { target: { value: "12345678" } });
    submit();

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith(
      "Password updated successfully for Alice",
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/auth/admin/set-user-password");
    expect(JSON.parse(init.body)).toEqual({
      userId: "user-123",
      newPassword: "12345678",
    });
    expect(input).toHaveValue("");
  });

  it("surfaces the backend's reason and stays open on a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(403, { message: "Not allowed" })),
    );
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
