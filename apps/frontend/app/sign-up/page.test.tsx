import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import SignUpPage from "./page";

const mockSignUpEmail = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://backend.test",
  useAuth: () => ({
    authClient: {
      signUp: {
        email: mockSignUpEmail,
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
 * answer to the availability read.
 */
const renderPage = () =>
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <SignUpPage />
    </SWRConfig>,
  );

/** Renders the page on a deployment with open sign-up, form shown. */
const renderOpen = async () => {
  stubSignUpAvailability(true);
  const utils = renderPage();
  await screen.findByLabelText("Password");
  return utils;
};

describe("SignUpPage when an invitation is required", () => {
  it("says sign-up is by invitation and offers no form", async () => {
    stubSignUpAvailability(false);

    renderPage();

    expect(
      await screen.findByRole("heading", {
        name: "Sign-up is by invitation",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sign up" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/sign-in",
    );
  });
});

describe("SignUpPage password reveal toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignUpEmail.mockResolvedValue({});
  });

  it("renders password masked as type='password' by default", async () => {
    await renderOpen();

    const passwordInput = screen.getByLabelText("Password");
    expect(passwordInput).toHaveAttribute("type", "password");
    expect(
      screen.getByRole("button", { name: "Show password" }),
    ).toBeInTheDocument();
  });

  it("toggles password visibility between text and password on click", async () => {
    await renderOpen();

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

  it("preserves typed password value across multiple toggle clicks", async () => {
    await renderOpen();

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

  it("submits the credentials when the form is submitted", async () => {
    const { container } = await renderOpen();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Ada Lovelace" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "my-secure-password" },
    });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(mockSignUpEmail).toHaveBeenCalledWith({
        email: "ada@example.com",
        password: "my-secure-password",
        name: "Ada Lovelace",
      });
    });
  });

  it("does not trigger form submission when clicking the reveal button", async () => {
    await renderOpen();

    const toggleButton = screen.getByRole("button", { name: "Show password" });

    // fireEvent.click does not run jsdom's form-submission algorithm, so the
    // type attribute is what actually pins this: a submit-typed toggle would
    // post the form in a real browser while leaving the mock untouched here.
    expect(toggleButton).toHaveAttribute("type", "button");

    fireEvent.click(toggleButton);

    expect(mockSignUpEmail).not.toHaveBeenCalled();
  });
});
