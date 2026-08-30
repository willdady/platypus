import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import SignUpPage from "./page";

const mockSignUpEmail = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    authClient: {
      signUp: {
        email: mockSignUpEmail,
      },
    },
  }),
}));

describe("SignUpPage password reveal toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignUpEmail.mockResolvedValue({});
  });

  it("renders password masked as type='password' by default", () => {
    render(<SignUpPage />);

    const passwordInput = screen.getByLabelText("Password");
    expect(passwordInput).toHaveAttribute("type", "password");
    expect(
      screen.getByRole("button", { name: "Show password" }),
    ).toBeInTheDocument();
  });

  it("toggles password visibility between text and password on click", () => {
    render(<SignUpPage />);

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
    render(<SignUpPage />);

    const passwordInput = screen.getByLabelText("Password");
    fireEvent.change(passwordInput, {
      target: { value: "my-secure-password" },
    });
    expect(passwordInput).toHaveValue("my-secure-password");

    const toggleButton = screen.getByRole("button", { name: "Show password" });

    // Repeated stress toggling
    for (let i = 0; i < 5; i++) {
      fireEvent.click(toggleButton);
      expect(passwordInput).toHaveAttribute("type", "text");
      expect(passwordInput).toHaveValue("my-secure-password");

      fireEvent.click(toggleButton);
      expect(passwordInput).toHaveAttribute("type", "password");
      expect(passwordInput).toHaveValue("my-secure-password");
    }
  });

  it("does not trigger form submission when clicking the reveal button", () => {
    render(<SignUpPage />);

    const toggleButton = screen.getByRole("button", { name: "Show password" });
    fireEvent.click(toggleButton);

    expect(mockSignUpEmail).not.toHaveBeenCalled();
  });
});
