import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { fetcher } from "@/lib/utils";
import SignInPage from "./page";

const mockSignInEmail = vi.fn();
const mockReplace = vi.fn();
const auth = vi.hoisted(() => ({ user: null as { id: string } | null }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://backend.test",
  useAuth: () => auth,
  useAuthClient: () => ({
    signIn: {
      email: mockSignInEmail,
    },
  }),
}));

function stubSignUpAvailability(open: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ open }),
    }),
  );
}

function renderPage() {
  const onSuccess = vi.fn();
  const utils = render(
    <SWRConfig value={{ provider: () => new Map(), fetcher, onSuccess }}>
      <SignInPage />
    </SWRConfig>,
  );
  const availabilityRead = () =>
    waitFor(() => expect(onSuccess).toHaveBeenCalled());
  return { ...utils, availabilityRead };
}

describe("SignInPage sign-up link", () => {
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
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});

describe("SignInPage heading", () => {
  it("names the page and says what to do", () => {
    stubSignUpAvailability(true);

    renderPage();

    expect(
      screen.getByRole("heading", { level: 1, name: "Sign in to Platypus" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Enter your credentials to continue"),
    ).toBeInTheDocument();
  });
});

describe("SignInPage form", () => {
  beforeEach(() => {
    stubSignUpAvailability(true);
  });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
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

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/"));
    expect(mockSignInEmail).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "super-secret-123",
    });
  });

  it("returns to the page that asked for sign-in", async () => {
    window.history.replaceState(null, "", "/sign-in?next=%2Forg1%3Ftab%3Da");
    mockSignInEmail.mockResolvedValue({});
    const { container } = renderPage();

    submit(container);

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith("/org1?tab=a"),
    );
  });

  it("goes home rather than off-site", async () => {
    window.history.replaceState(
      null,
      "",
      "/sign-in?next=%2F%2Fevil.example%2Forg1",
    );
    mockSignInEmail.mockResolvedValue({});
    const { container } = renderPage();

    submit(container);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/"));
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
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });
});

describe("SignInPage with a session", () => {
  beforeEach(() => {
    stubSignUpAvailability(true);
    auth.user = null;
  });

  it("enters the app when already signed in", () => {
    auth.user = { id: "u1" };
    renderPage();

    expect(mockReplace).toHaveBeenCalledWith("/");
  });

  it("shows the form while signed out", () => {
    renderPage();

    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});
