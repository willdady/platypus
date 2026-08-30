import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SignInPage from "./page";

const mockSignInEmail = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    authClient: {
      signIn: {
        email: mockSignInEmail,
      },
    },
  }),
}));

describe("SignInPage password reveal toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignInEmail.mockResolvedValue({});
  });

  it("renders password masked as type='password' by default", () => {
    render(<SignInPage />);

    const passwordInput = screen.getByLabelText("Password");
    expect(passwordInput).toHaveAttribute("type", "password");
    expect(
      screen.getByRole("button", { name: "Show password" }),
    ).toBeInTheDocument();
  });

  it("toggles password visibility between text and password on click", () => {
    render(<SignInPage />);

    const passwordInput = screen.getByLabelText("Password");
    const toggleButton = screen.getByRole("button", { name: "Show password" });

    // Click to reveal
    fireEvent.click(toggleButton);
    expect(passwordInput).toHaveAttribute("type", "text");
    expect(
      screen.getByRole("button", { name: "Hide password" }),
    ).toBeInTheDocument();

    // Click to conceal
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(passwordInput).toHaveAttribute("type", "password");
    expect(
      screen.getByRole("button", { name: "Show password" }),
    ).toBeInTheDocument();
  });

  it("preserves typed password value across multiple toggle clicks", () => {
    render(<SignInPage />);

    const passwordInput = screen.getByLabelText("Password");
    fireEvent.change(passwordInput, { target: { value: "super-secret-123" } });
    expect(passwordInput).toHaveValue("super-secret-123");

    const toggleButton = screen.getByRole("button", { name: "Show password" });

    // Repeated stress toggling
    for (let i = 0; i < 5; i++) {
      fireEvent.click(toggleButton);
      expect(passwordInput).toHaveAttribute("type", "text");
      expect(passwordInput).toHaveValue("super-secret-123");

      fireEvent.click(toggleButton);
      expect(passwordInput).toHaveAttribute("type", "password");
      expect(passwordInput).toHaveValue("super-secret-123");
    }
  });

  it("submits the credentials when the form is submitted", async () => {
    const { container } = render(<SignInPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "super-secret-123" },
    });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(mockSignInEmail).toHaveBeenCalledWith({
        email: "user@example.com",
        password: "super-secret-123",
      });
    });
  });

  it("does not trigger form submission when clicking the reveal button", () => {
    render(<SignInPage />);

    const toggleButton = screen.getByRole("button", { name: "Show password" });

    // fireEvent.click does not run jsdom's form-submission algorithm, so the
    // type attribute is what actually pins this: a submit-typed toggle would
    // post the form in a real browser while leaving the mock untouched here.
    expect(toggleButton).toHaveAttribute("type", "button");

    fireEvent.click(toggleButton);

    expect(mockSignInEmail).not.toHaveBeenCalled();
  });
});
