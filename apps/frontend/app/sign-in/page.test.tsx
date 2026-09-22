import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import SignInPage from "./page";

const mockSignInEmail = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://backend.test",
  useAuth: () => ({
    authClient: {
      signIn: {
        email: mockSignInEmail,
      },
    },
  }),
}));

/** What the backend's sign-up availability endpoint answers. */
const stubSignUpAvailability = (open: boolean) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ open }),
    }),
  );
};

/**
 * Renders the page with an SWR cache of its own, so no test sees another's
 * answer to the availability read, and returns a wait for that read to have
 * landed — the point after which "the link is not there" means the page chose
 * not to show it, rather than that it has not heard yet.
 */
const renderPage = () => {
  const onSuccess = vi.fn();
  const utils = render(
    <SWRConfig value={{ provider: () => new Map(), onSuccess }}>
      <SignInPage />
    </SWRConfig>,
  );
  const availabilityRead = () =>
    waitFor(() => expect(onSuccess).toHaveBeenCalled());
  return { ...utils, availabilityRead };
};

describe("SignInPage sign-up link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers Sign up while sign-up is open", async () => {
    stubSignUpAvailability(true);

    renderPage();

    expect(
      await screen.findByRole("link", { name: "Sign up" }),
    ).toHaveAttribute("href", "/sign-up");
  });

  it("does not offer Sign up when an invitation is required", async () => {
    stubSignUpAvailability(false);

    const { availabilityRead } = renderPage();
    await availabilityRead();

    expect(
      screen.queryByRole("link", { name: "Sign up" }),
    ).not.toBeInTheDocument();
    // Signing in is untouched by the requirement.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});

describe("SignInPage password reveal toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignInEmail.mockResolvedValue({});
    stubSignUpAvailability(true);
  });

  it("renders password masked as type='password' by default", () => {
    renderPage();

    const passwordInput = screen.getByLabelText("Password");
    expect(passwordInput).toHaveAttribute("type", "password");
    expect(
      screen.getByRole("button", { name: "Show password" }),
    ).toBeInTheDocument();
  });

  it("toggles password visibility between text and password on click", () => {
    renderPage();

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
    renderPage();

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
    const { container } = renderPage();

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
    renderPage();

    const toggleButton = screen.getByRole("button", { name: "Show password" });

    // fireEvent.click does not run jsdom's form-submission algorithm, so the
    // type attribute is what actually pins this: a submit-typed toggle would
    // post the form in a real browser while leaving the mock untouched here.
    expect(toggleButton).toHaveAttribute("type", "button");

    fireEvent.click(toggleButton);

    expect(mockSignInEmail).not.toHaveBeenCalled();
  });
});
