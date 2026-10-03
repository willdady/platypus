import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  installRadixPointerPolyfills,
  jsonResponse,
  openDropdownMenu,
} from "@/lib/test-utils";

beforeAll(installRadixPointerPolyfills);

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

afterEach(() => vi.unstubAllGlobals());

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

    expect(lastConfigFor("/notifications")?.refreshInterval).toBe(0);
    expect(lastConfigFor("/unread-count")?.refreshInterval).toBe(0);
    expect(lastConfigFor("/users/me/invitations")?.refreshInterval).toBe(0);
  });

  it("starts polling the workspace feeds and invitations once opened", () => {
    render(<NotificationsDropdown orgId="org1" workspaceId="ws1" />);
    openDropdownMenu();

    expect(lastConfigFor("/notifications")?.refreshInterval).toBe(30000);
    expect(lastConfigFor("/unread-count")?.refreshInterval).toBe(30000);
    expect(lastConfigFor("/users/me/invitations")?.refreshInterval).toBe(
      120000,
    );
  });

  it("reads notifications through the workspace-scoped key", () => {
    render(<NotificationsDropdown orgId="org1" workspaceId="ws1" />);

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

  it("counts unread notifications and pending invitations on the bell", () => {
    renderWithFeed();

    expect(
      screen.getByRole("button", { name: "Notifications (2)" }),
    ).toBeInTheDocument();
    openDropdownMenu();
    expect(screen.getByText("Nightly digest")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });

  it("marks an unread notification read when it is opened", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    renderWithFeed();
    openDropdownMenu();
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
    openDropdownMenu();
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

  it("marks everything read in one write", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    renderWithFeed();
    openDropdownMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Mark all as read" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${NOTIFICATIONS_URL}/read-all`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});

describe("NotificationsDropdown body", () => {
  const renderBody = (body: string) => {
    feeds["/notifications"] = { results: [{ ...unread, body }] };
    render(<NotificationsDropdown orgId="org1" workspaceId="ws1" />);
    openDropdownMenu();
  };

  it("renders an unordered list with every item", () => {
    renderBody("Acceptance criteria:\n- item one\n- item two\n\nSize: S");

    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["item one", "item two"]);
    expect(items[0].closest("ul")).not.toBeNull();
    expect(screen.getByText("Size: S")).toBeInTheDocument();
  });

  it("renders an ordered list with every item", () => {
    renderBody("1. first\n2. second");

    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["first", "second"]);
    expect(items[0].closest("ol")).not.toBeNull();
  });

  it("shows a disallowed block's text without its element", () => {
    renderBody("## Title\n\nDetails");

    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Title" })).toBeNull();
  });

  it("confirms a link before opening it, without toggling the entry", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    renderBody("See [the run](https://example.com/run)");

    fireEvent.click(screen.getByRole("button", { name: "the run" }));

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
    expect(screen.queryByText("Show less")).toBeNull();
    expect(screen.getByText("Nightly digest")).toBeInTheDocument();
  });
});
