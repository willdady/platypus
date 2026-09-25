import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import SignInPage from "./page";

const mockSignInEmail = vi.fn();
const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
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

describe("SignInPage form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubSignUpAvailability(true);
  });

  const submit = (container: HTMLElement) => {
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "super-secret-123" },
    });
    fireEvent.submit(container.querySelector("form")!);
  };

  // The reveal toggle itself is covered in components/ui/revealable-input.
  it("masks the password field", () => {
    renderPage();

    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "type",
      "password",
    );
  });

  it("submits the credentials and enters the app", async () => {
    mockSignInEmail.mockResolvedValue({});
    const { container } = renderPage();

    submit(container);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/"));
    expect(mockSignInEmail).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "super-secret-123",
    });
  });

  it.each([
    [
      "the backend's reason",
      () => ({ error: { message: "Invalid email or password" } }),
      "Invalid email or password",
    ],
    [
      "a fallback for a reasonless refusal",
      () => ({ error: {} }),
      "Sign in failed",
    ],
    [
      "a generic failure when the request throws",
      () => {
        throw new Error("network");
      },
      "An unexpected error occurred",
    ],
  ])("shows %s and stays on the page", async (_name, impl, message) => {
    mockSignInEmail.mockImplementation(async () => impl());
    const { container } = renderPage();

    submit(container);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });
});
