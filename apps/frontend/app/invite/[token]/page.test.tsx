import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import InviteTokenPage from "./page";
import { jsonResponse } from "@/lib/test-utils";

const mockPush = vi.fn();
const mockSignOut = vi.fn();
const mockRefreshSession = vi.fn().mockResolvedValue(undefined);

/**
 * Each test uses a distinct token, so each gets its own SWR cache entry —
 * `useSWR` caches and dedupes by key at module scope, so reusing one token
 * across tests would let a later test observe an earlier test's cached
 * resolution instead of exercising its own mocked fetch.
 */
let mockToken = "tok_0";

vi.mock("next/navigation", () => ({
  useParams: () => ({ token: mockToken }),
  useRouter: () => ({ push: mockPush }),
}));

/** The current session; each test sets it before rendering. */
let mockUser: { email: string } | null = null;

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://backend.test",
  useAuth: () => ({
    user: mockUser,
    isPending: false,
    refreshSession: mockRefreshSession,
    authClient: { signOut: mockSignOut },
  }),
}));

const RESOLUTION_BODY = {
  email: "invitee@example.com",
  organizationName: "Acme",
};

/** What the register and accept endpoints return: where the accept landed. */
const ACCEPT_BODY = {
  message: "Invitation accepted",
  organizationId: "org-9",
  workspaceId: "ws-9",
};
const WORKSPACE_PATH = "/org-9/workspace/ws-9";

/**
 * Stubs `fetch` to answer the link's resolution with `RESOLUTION_BODY`, and
 * `/register` or `/accept` with whatever the test stages for them.
 */
const stubInvite = (
  routes: Partial<Record<"register" | "accept", [number, unknown]>> = {},
) => {
  const fetchMock = vi.fn(async (url: string) => {
    const route = (["register", "accept"] as const).find((r) =>
      String(url).endsWith(`/${r}`),
    );
    const [status, body] = (route && routes[route]) ?? [200, RESOLUTION_BODY];
    return jsonResponse(status, body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const called = (fetchMock: ReturnType<typeof stubInvite>, suffix: string) =>
  fetchMock.mock.calls.some(([url]) => String(url).endsWith(suffix));

const fillRegistration = async () => {
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "Robin" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "at-least-8-chars" },
  });
  fireEvent.click(screen.getByRole("button", { name: /accept invitation/i }));
};

describe("InviteTokenPage", () => {
  let tokenCounter = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = null;
    mockToken = `tok_${++tokenCounter}`;
    window.history.replaceState(null, "", `/invite/${mockToken}`);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("scrubs the token from the visible URL on mount", () => {
    stubInvite();

    render(<InviteTokenPage />);

    expect(window.location.pathname).toBe("/invite");
  });

  it("holds a skeleton, not the not-found message, while the link resolves", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    render(<InviteTokenPage />);

    expect(
      screen.getByRole("status", { name: "Loading invitation" }),
    ).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Invitation not found")).not.toBeInTheDocument();
  });

  it("shows a not-found message for an invalid or already-redeemed token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, {})));

    render(<InviteTokenPage />);

    expect(await screen.findByText("Invitation not found")).toBeInTheDocument();
  });

  describe("no session", () => {
    it("renders a registration form with the invited email fixed and non-editable", async () => {
      stubInvite();

      render(<InviteTokenPage />);

      const emailInput = (await screen.findByLabelText(
        "Email",
      )) as HTMLInputElement;
      expect(emailInput.value).toBe("invitee@example.com");
      expect(emailInput).toBeDisabled();
      expect(screen.getByText("Acme", { exact: false })).toBeInTheDocument();
    });

    it("registers via /register and redirects on success", async () => {
      const fetchMock = stubInvite({ register: [200, ACCEPT_BODY] });

      render(<InviteTokenPage />);
      await fillRegistration();

      // Straight into the Workspace the accept provisioned -- not "/", which
      // for a member of other Organizations may not resolve to this one.
      await waitFor(() =>
        expect(mockPush).toHaveBeenCalledWith(WORKSPACE_PATH),
      );
      expect(mockPush).not.toHaveBeenCalledWith("/");

      const registerCall = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/register"),
      ) as unknown as [string, RequestInit];
      expect(registerCall[1]).toMatchObject({
        method: "POST",
        credentials: "include",
      });
      expect(JSON.parse(String(registerCall[1].body))).toEqual({
        name: "Robin",
        password: "at-least-8-chars",
      });
    });

    it("keeps the registration form, with the reason, when it is refused", async () => {
      stubInvite({ register: [400, { error: "Password is too short" }] });

      render(<InviteTokenPage />);
      await fillRegistration();

      expect(
        await screen.findByText("Password is too short"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Name")).toHaveValue("Robin");
      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  describe("signed in as the invited address", () => {
    it("shows a single Accept action and redirects on success", async () => {
      mockUser = { email: "invitee@example.com" };
      const fetchMock = stubInvite({ accept: [200, ACCEPT_BODY] });

      render(<InviteTokenPage />);

      fireEvent.click(
        await screen.findByRole("button", { name: /accept invitation/i }),
      );

      await waitFor(() =>
        expect(mockPush).toHaveBeenCalledWith(WORKSPACE_PATH),
      );
      expect(mockPush).not.toHaveBeenCalledWith("/");
      expect(called(fetchMock, "/accept")).toBe(true);
    });

    it("says why and stays put when the accept is refused", async () => {
      mockUser = { email: "invitee@example.com" };
      stubInvite({ accept: [404, { error: "Invitation link not found" }] });

      render(<InviteTokenPage />);

      fireEvent.click(
        await screen.findByRole("button", { name: /accept invitation/i }),
      );

      expect(
        await screen.findByText("Invitation link not found"),
      ).toBeInTheDocument();
      expect(mockPush).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: /accept invitation/i }),
      ).toBeEnabled();
    });
  });

  describe("signed in as a different address", () => {
    it("refuses, explains, and offers sign-out without calling accept or register", async () => {
      mockUser = { email: "someone-else@example.com" };
      const fetchMock = stubInvite();

      render(<InviteTokenPage />);

      expect(await screen.findByText("Wrong account")).toBeInTheDocument();
      expect(
        screen.getByText("someone-else@example.com", { exact: false }),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
      expect(mockSignOut).toHaveBeenCalled();

      expect(called(fetchMock, "/accept")).toBe(false);
      expect(called(fetchMock, "/register")).toBe(false);
    });
  });
});
