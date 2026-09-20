import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import InviteTokenPage from "./page";

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

describe("InviteTokenPage", () => {
  let tokenCounter = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = null;
    mockToken = `tok_${++tokenCounter}`;
    window.history.replaceState(null, "", `/invite/${mockToken}`);
  });

  it("scrubs the token from the visible URL on mount", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => RESOLUTION_BODY,
      }),
    );

    render(<InviteTokenPage />);

    expect(window.location.pathname).toBe("/invite");
  });

  it("shows a not-found message for an invalid or already-redeemed token", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );

    render(<InviteTokenPage />);

    expect(await screen.findByText("Invitation not found")).toBeInTheDocument();
  });

  describe("no session", () => {
    it("renders a registration form with the invited email fixed and non-editable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => RESOLUTION_BODY,
        }),
      );

      render(<InviteTokenPage />);

      const emailInput = (await screen.findByLabelText(
        "Email",
      )) as HTMLInputElement;
      expect(emailInput.value).toBe("invitee@example.com");
      expect(emailInput).toBeDisabled();
      expect(screen.getByText("Acme", { exact: false })).toBeInTheDocument();
    });

    it("registers via /register and redirects on success", async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (String(url).endsWith("/register")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ACCEPT_BODY,
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => RESOLUTION_BODY,
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<InviteTokenPage />);

      fireEvent.change(await screen.findByLabelText("Name"), {
        target: { value: "Robin" },
      });
      fireEvent.change(screen.getByLabelText("Password"), {
        target: { value: "at-least-8-chars" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: /accept invitation/i }),
      );

      // Straight into the Workspace the accept provisioned -- not "/", which
      // for a member of other Organizations may not resolve to this one.
      await waitFor(() =>
        expect(mockPush).toHaveBeenCalledWith(WORKSPACE_PATH),
      );
      expect(mockPush).not.toHaveBeenCalledWith("/");

      const registerCall = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/register"),
      );
      expect(registerCall?.[1]).toMatchObject({
        method: "POST",
        credentials: "include",
      });
      expect(JSON.parse(registerCall![1].body)).toEqual({
        name: "Robin",
        password: "at-least-8-chars",
      });
    });
  });

  describe("signed in as the invited address", () => {
    it("shows a single Accept action and redirects on success", async () => {
      mockUser = { email: "invitee@example.com" };
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (String(url).endsWith("/accept")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ACCEPT_BODY,
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => RESOLUTION_BODY,
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<InviteTokenPage />);

      fireEvent.click(
        await screen.findByRole("button", { name: /accept invitation/i }),
      );

      await waitFor(() =>
        expect(mockPush).toHaveBeenCalledWith(WORKSPACE_PATH),
      );
      expect(mockPush).not.toHaveBeenCalledWith("/");
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith("/accept")),
      ).toBe(true);
    });
  });

  describe("signed in as a different address", () => {
    it("refuses, explains, and offers sign-out without calling accept or register", async () => {
      mockUser = { email: "someone-else@example.com" };
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => RESOLUTION_BODY,
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<InviteTokenPage />);

      expect(await screen.findByText("Wrong account")).toBeInTheDocument();
      expect(
        screen.getByText("someone-else@example.com", { exact: false }),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
      expect(mockSignOut).toHaveBeenCalled();

      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            String(url).endsWith("/accept") ||
            String(url).endsWith("/register"),
        ),
      ).toBe(false);
    });
  });
});
