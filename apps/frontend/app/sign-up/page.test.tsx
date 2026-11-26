import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { fetcher } from "@/lib/utils";
import SignUpPage from "./page";

const mockSignUpEmail = vi.fn();
const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://backend.test",
  useAuthClient: () => ({
    signUp: {
      email: mockSignUpEmail,
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
  return render(
    <SWRConfig value={{ provider: () => new Map(), fetcher }}>
      <SignUpPage />
    </SWRConfig>,
  );
}

async function renderOpen() {
  stubSignUpAvailability(true);
  const utils = renderPage();
  await screen.findByLabelText("Password");
  return utils;
}

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

describe("SignUpPage heading", () => {
  it("names the page and says what to do while sign-up is open", async () => {
    stubSignUpAvailability(true);

    renderPage();

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Create an account",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Sign up to get started with Platypus"),
    ).toBeInTheDocument();
  });

  it("explains how to join while an invitation is required", async () => {
    stubSignUpAvailability(false);

    renderPage();

    expect(
      await screen.findByText(
        "This deployment does not accept open sign-ups.",
        {
          exact: false,
        },
      ),
    ).toBeInTheDocument();
  });
});

describe("SignUpPage form", () => {
  const submit = (container: HTMLElement) => {
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
  };

  it("masks the password field", async () => {
    await renderOpen();

    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "type",
      "password",
    );
  });

  it("submits the credentials and enters the app", async () => {
    mockSignUpEmail.mockResolvedValue({});
    const { container } = await renderOpen();

    submit(container);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/"));
    expect(mockSignUpEmail).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "my-secure-password",
      name: "Ada Lovelace",
    });
  });

  it.each([
    [
      "the backend's reason",
      () => ({ error: { message: "User already exists" } }),
      "User already exists",
    ],
    [
      "a fallback for a reasonless refusal",
      () => ({ error: {} }),
      "Sign up failed",
    ],
    [
      "a generic failure when the request throws",
      () => {
        throw new Error("network");
      },
      "An unexpected error occurred",
    ],
  ])("shows %s and stays on the page", async (_name, impl, message) => {
    mockSignUpEmail.mockImplementation(async () => impl());
    const { container } = await renderOpen();

    submit(container);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
