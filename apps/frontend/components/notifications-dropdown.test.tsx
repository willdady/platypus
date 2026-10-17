import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { jsonResponse, openDropdownMenu } from "@/test/test-utils";

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ user: { id: "u1" } }),
}));

interface SwrCall {
  key: string | null;
  config?: { refreshInterval?: number };
}

const { swrCalls, feeds, mutate, toastError } = vi.hoisted(() => ({
  swrCalls: [] as SwrCall[],
  // What each read returns, keyed by the tail of its URL.
  feeds: {} as Record<string, unknown>,
  mutate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: toastError } }));

vi.mock("swr", () => ({
  useSWRConfig: () => ({ cache: new Map() }),
  __esModule: true,
  default: (key: string | null, _fn: unknown, config?: SwrCall["config"]) => {
    swrCalls.push({ key, config });
    const tail = Object.keys(feeds).find((t) => key?.endsWith(t));
    return {
      data: tail ? feeds[tail] : { results: [], count: 0 },
      mutate,
    };
  },
}));

import { NotificationsDropdown } from "./notifications-dropdown";

function lastConfigFor(keyFragment: string): SwrCall["config"] {
  const call = [...swrCalls]
    .reverse()
    .find((c) => c.key?.includes(keyFragment));
  if (!call) throw new Error(`No SWR call for ${keyFragment}`);
  return call.config;
}

beforeEach(() => {
  swrCalls.length = 0;
  for (const tail of Object.keys(feeds)) delete feeds[tail];
  mutate.mockReset();
  toastError.mockReset();
});

const NOTIFICATIONS_URL =
  "http://test/organizations/org1/workspaces/ws1/notifications";

const unread = {
  id: "n1",
  agentName: "Scout",
  title: "Nightly digest",
  body: "All green",
  isRead: false,
  createdAt: new Date().toISOString(),
};

describe("NotificationsDropdown polling", () => {
  it("does not poll any feed while the dropdown is closed", () => {
    render(<NotificationsDropdown orgId="org1" workspaceId="ws1" />);

    expect(lastConfigFor("/unread-count")?.refreshInterval).toBe(0);
    expect(lastConfigFor("/users/me/invitations")?.refreshInterval).toBe(0);
  });

  it("starts polling the workspace feeds and invitations once opened", async () => {
    render(<NotificationsDropdown orgId="org1" workspaceId="ws1" />);
    await openDropdownMenu();

    expect(lastConfigFor("/notifications")?.refreshInterval).toBe(30000);
    expect(lastConfigFor("/unread-count")?.refreshInterval).toBe(30000);
    expect(lastConfigFor("/users/me/invitations")?.refreshInterval).toBe(
      120000,
    );
  });

  it("leaves the notification list unread until the bell opens", async () => {
    render(<NotificationsDropdown orgId="org1" workspaceId="ws1" />);

    expect(swrCalls.some((c) => c.key === NOTIFICATIONS_URL)).toBe(false);
    await openDropdownMenu();
    expect(swrCalls.some((c) => c.key === NOTIFICATIONS_URL)).toBe(true);
  });

  it("reads notifications through the workspace-scoped key", async () => {
    render(<NotificationsDropdown orgId="org1" workspaceId="ws1" />);
    await openDropdownMenu();

    expect(
      swrCalls.some(
        (c) =>
          c.key ===
          "http://test/organizations/org1/workspaces/ws1/notifications",
      ),
    ).toBe(true);
  });
});

describe("NotificationsDropdown feed", () => {
  const renderWithFeed = () => {
    feeds["/notifications"] = { results: [unread] };
    feeds["/unread-count"] = { count: 1 };
    feeds["/users/me/invitations"] = {
      results: [{ id: "i1", organizationName: "Acme" }],
    };
    render(<NotificationsDropdown orgId="org1" workspaceId="ws1" />);
  };

  it("counts unread notifications and pending invitations on the bell", async () => {
    renderWithFeed();

    expect(
      screen.getByRole("button", { name: "Notifications (2)" }),
    ).toBeInTheDocument();
    await openDropdownMenu();
    expect(screen.getByText("Nightly digest")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("marks an unread notification read when it is opened", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    renderWithFeed();
    await openDropdownMenu();
    mutate.mockReset();

    fireEvent.click(screen.getByText("Nightly digest"));

    expect(screen.getByText("Show less")).toBeInTheDocument();
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledWith(
      `${NOTIFICATIONS_URL}/n1/read`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("dismisses a notification, and says why when that is refused", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(403, { error: "Not yours" }));
    vi.stubGlobal("fetch", fetchMock);
    renderWithFeed();
    await openDropdownMenu();
    mutate.mockReset();

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Not yours"));
    expect(fetchMock).toHaveBeenCalledWith(
      `${NOTIFICATIONS_URL}/n1`,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(mutate).not.toHaveBeenCalled();
  });

  it("hides a dismissed notification at once and restores it if refused", async () => {
    let refuse!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            refuse = () => resolve(jsonResponse(403, { error: "Not yours" }));
          }),
      ),
    );
    renderWithFeed();
    await openDropdownMenu();

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );

    expect(screen.queryByText("Nightly digest")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Notifications (1)",
        // Radix hides the trigger from the a11y tree while the menu is open.
        hidden: true,
      }),
    ).toBeInTheDocument();

    await act(async () => refuse());

    expect(screen.getByText("Nightly digest")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Notifications (2)", hidden: true }),
    ).toBeInTheDocument();
  });

  it("counts a notification read at once and unread again if refused", async () => {
    let refuse!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            refuse = () => resolve(jsonResponse(403, { error: "Not yours" }));
          }),
      ),
    );
    renderWithFeed();
    await openDropdownMenu();

    fireEvent.click(screen.getByText("Nightly digest"));

    expect(
      screen.getByRole("button", { name: "Notifications (1)", hidden: true }),
    ).toBeInTheDocument();

    await act(async () => refuse());

    expect(toastError).toHaveBeenCalledWith("Not yours");
    expect(
      screen.getByRole("button", { name: "Notifications (2)", hidden: true }),
    ).toBeInTheDocument();
  });

  it("keeps a dismissed row hidden when an earlier mark-read lands", async () => {
    const answers: Array<() => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            answers.push(() => resolve(jsonResponse(200, {})));
          }),
      ),
    );
    renderWithFeed();
    await openDropdownMenu();

    fireEvent.click(screen.getByText("Nightly digest"));
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    await act(async () => answers[0]());

    expect(screen.queryByText("Nightly digest")).not.toBeInTheDocument();
  });

  it("marks everything read in one write", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    renderWithFeed();
    await openDropdownMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Mark all as read" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${NOTIFICATIONS_URL}/read-all`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});

describe("NotificationsDropdown keyboard", () => {
  const renderFeed = async () => {
    feeds["/notifications"] = { results: [unread] };
    feeds["/unread-count"] = { count: 1 };
    render(<NotificationsDropdown orgId="org1" workspaceId="ws1" />);
    await openDropdownMenu();
  };
  const row = () => screen.getByRole("menuitem", { name: /Nightly digest/ });

  it("makes each notification a menu item the arrow keys reach", async () => {
    await renderFeed();

    expect(row()).toBeInTheDocument();
  });

  it("says a notification is unread in words, not just a dot", async () => {
    await renderFeed();

    expect(within(row()).getByText("Unread")).toHaveClass("sr-only");
  });

  it("expands and marks read on Enter, keeping the menu open", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    await renderFeed();

    fireEvent.keyDown(row(), { key: "Enter" });

    expect(screen.getByText("Show less")).toBeInTheDocument();
    expect(row()).toHaveAttribute("aria-expanded", "true");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${NOTIFICATIONS_URL}/n1/read`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("dismisses the focused notification on Delete", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    await renderFeed();

    expect(row()).toHaveAttribute("aria-keyshortcuts", "Delete");
    fireEvent.keyDown(row(), { key: "Delete" });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${NOTIFICATIONS_URL}/n1`,
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });
});

describe("NotificationsDropdown body", () => {
  const renderBody = async (body: string) => {
    feeds["/notifications"] = { results: [{ ...unread, body }] };
    render(<NotificationsDropdown orgId="org1" workspaceId="ws1" />);
    await openDropdownMenu();
  };

  // The body's renderer loads on demand, so each read waits for it.
  it("renders an unordered list with every item", async () => {
    await renderBody("Acceptance criteria:\n- item one\n- item two\n\nSize: S");

    const items = await screen.findAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["item one", "item two"]);
    expect(items[0].closest("ul")).not.toBeNull();
    expect(screen.getByText("Size: S")).toBeInTheDocument();
  });

  it("renders an ordered list with every item", async () => {
    await renderBody("1. first\n2. second");

    const items = await screen.findAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["first", "second"]);
    expect(items[0].closest("ol")).not.toBeNull();
  });

  it("shows a disallowed block's text without its element", async () => {
    await renderBody("## Title\n\nDetails");

    expect(await screen.findByText("Title")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Title" }),
    ).not.toBeInTheDocument();
  });

  it("confirms a link before opening it, without toggling the entry", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await renderBody("See [the run](https://example.com/run)");

    fireEvent.click(await screen.findByRole("button", { name: "the run" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Open external link?",
    });
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open link" }));
    expect(open).toHaveBeenCalledWith(
      "https://example.com/run",
      "_blank",
      "noreferrer",
    );
    expect(screen.queryByText("Show less")).not.toBeInTheDocument();
    expect(screen.getByText("Nightly digest")).toBeInTheDocument();
  });

  it("cancels the confirmation and leaves the dropdown open", async () => {
    await renderBody("See [the run](https://example.com/run)");
    const link = await screen.findByRole("button", { name: "the run" });

    await act(async () => {
      fireEvent.click(link);
    });
    const dialog = screen.getByRole("dialog", { name: "Open external link?" });
    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(
      screen.queryByRole("dialog", { name: "Open external link?" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Nightly digest")).toBeInTheDocument();
    expect(screen.queryByText("Show less")).not.toBeInTheDocument();
  });
});

describe("NotificationsDropdown source link", () => {
  const renderWithSource = async (source: unknown) => {
    feeds["/notifications"] = { results: [{ ...unread, source }] };
    render(<NotificationsDropdown orgId="org1" workspaceId="ws1" />);
    await openDropdownMenu();
  };

  it.each([
    [{ kind: "chat", chatId: "chat-1" }, "/org1/workspace/ws1/chat/chat-1"],
    [
      { kind: "triggerRun", triggerRunId: "run-1" },
      "/org1/workspace/ws1/trigger-runs/run-1",
    ],
  ])("links a notification from %o to its page", async (source, href) => {
    await renderWithSource(source);

    expect(screen.getByRole("menuitem", { name: "Open" })).toHaveAttribute(
      "href",
      href,
    );
  });

  it("shows no link for a notification without a source", async () => {
    await renderWithSource(null);

    expect(
      screen.queryByRole("menuitem", { name: "Open" }),
    ).not.toBeInTheDocument();
  });

  it("marks it read and closes the bell when the link is followed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    await renderWithSource({ kind: "chat", chatId: "chat-1" });

    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${NOTIFICATIONS_URL}/n1/read`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(screen.queryByText("Nightly digest")).not.toBeInTheDocument();
  });
});
