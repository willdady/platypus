import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "@/components/auth-provider";
import { ProtectedRoute } from "@/components/protected-route";
import InviteTokenPage from "./page";

const push = vi.fn();
let sequence = 0;
let backendUrl: string;
vi.mock("next/navigation", () => ({
  useParams: () => ({ token: `session-test-${sequence}` }),
  useRouter: () => ({ push }),
}));

const WORKSPACE_PATH = "/org-9/workspace/ws-9";
const acceptedBody = {
  message: "Invitation accepted",
  organizationId: "org-9",
  workspaceId: "ws-9",
};

const invitedUser = {
  id: "invitee",
  email: "invitee@example.com",
  name: "Robin",
  role: "user",
};
let currentUser: typeof invitedUser | null;
let registrationConflict: boolean;
let signInFailure: boolean;

function Probe() {
  const { user, isPending } = useAuth();
  return (
    <p data-testid="session">
      {isPending ? "pending" : (user?.email ?? "anonymous")}
    </p>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  backendUrl = `http://localhost:${4100 + ++sequence}`;
  currentUser = null;
  registrationConflict = false;
  signInFailure = false;
  window.history.replaceState(null, "", `/invite/session-test-${sequence}`);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/get-session"))
        return Response.json(
          currentUser
            ? {
                user: currentUser,
                session: { id: "session", userId: currentUser.id },
              }
            : null,
        );
      if (url.endsWith("/register")) {
        if (registrationConflict)
          return Response.json(
            { error: "An account already exists. Sign in instead." },
            { status: 409 },
          );
        currentUser = invitedUser;
        return Response.json(acceptedBody);
      }
      if (url.endsWith("/sign-in/email")) {
        if (signInFailure)
          return Response.json(
            { message: "Invalid email or password" },
            { status: 401 },
          );
        currentUser = invitedUser;
        return Response.json({ user: invitedUser, token: "test-session" });
      }
      if (url.endsWith("/sign-out")) {
        currentUser = null;
        return Response.json({ success: true });
      }
      if (url.endsWith("/accept")) return Response.json(acceptedBody);
      if (url.includes("/invitation-links/"))
        return Response.json({
          email: invitedUser.email,
          organizationName: "Acme",
        });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
});

function renderPage() {
  return render(
    <AuthProvider backendUrl={backendUrl}>
      <Probe />
      <InviteTokenPage />
    </AuthProvider>,
  );
}

it("refreshes the real client session before entering a protected page after registration", async () => {
  const view = renderPage();
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "Robin" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "review-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
  await waitFor(() => expect(push).toHaveBeenCalledWith(WORKSPACE_PATH));
  expect(screen.getByTestId("session")).toHaveTextContent(invitedUser.email);
  view.rerender(
    <AuthProvider backendUrl={backendUrl}>
      <Probe />
      <ProtectedRoute>
        <p>Protected home</p>
      </ProtectedRoute>
    </AuthProvider>,
  );
  expect(await screen.findByText("Protected home")).toBeInTheDocument();
  expect(push).not.toHaveBeenCalledWith("/sign-in");
});

it("lets an existing account sign in and accept without losing or restoring the token URL", async () => {
  renderPage();
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Already have an account? Sign in",
    }),
  );
  expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "existing-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  const accept = await screen.findByRole("button", {
    name: "Accept invitation",
  });
  await waitFor(() => expect(accept).toBeEnabled());
  expect(window.location.pathname).toBe("/invite");
  expect(push).not.toHaveBeenCalled();
  fireEvent.click(accept);
  await waitFor(() => expect(push).toHaveBeenCalledWith(WORKSPACE_PATH));
  const calls = vi.mocked(fetch).mock.calls;
  expect(
    calls.some(([url]) =>
      String(url).endsWith(`/session-test-${sequence}/accept`),
    ),
  ).toBe(true);
  expect(calls.some(([url]) => String(url).endsWith("/register"))).toBe(false);
});

it("offers inline sign-in after a registration conflict and retains the invitation after a failed password", async () => {
  registrationConflict = true;
  renderPage();
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "Robin" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "new-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
  const signIn = await screen.findByRole("button", { name: "Sign in" });
  expect(screen.getByLabelText("Password")).toHaveValue("");
  signInFailure = true;
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "incorrect" },
  });
  fireEvent.click(signIn);
  expect(
    await screen.findByText("Invalid email or password"),
  ).toBeInTheDocument();
  expect(screen.getByTestId("session")).toHaveTextContent("anonymous");
  expect(push).not.toHaveBeenCalled();
  expect(window.location.pathname).toBe("/invite");
});

it("can switch from the wrong account to the invited account on the same page", async () => {
  currentUser = { ...invitedUser, id: "other", email: "other@example.com" };
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Already have an account? Sign in",
    }),
  );
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "existing-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(
    await screen.findByRole("button", { name: "Accept invitation" }),
  ).toBeInTheDocument();
  expect(screen.getByTestId("session")).toHaveTextContent(invitedUser.email);
  expect(window.location.pathname).toBe("/invite");
});
