import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { jsonResponse } from "@/test/test-utils";
import type { Actor } from "@/lib/authorization";

// --- Module mocks ------------------------------------------------------------

const { params, reads, auth } = vi.hoisted(() => ({
  params: { orgId: "org1", workspaceId: "ws1" },
  auth: {
    actor: "org-admin",
    ownsWorkspace: true,
    workspaceDelegation: null as { providerSelfManagement: boolean } | null,
  },
  // Keyed by `${workspaceId}|${entity}`. Each entry is handed back by
  // reference, as SWR does, so a read's `data` identity is stable across
  // renders.
  reads: new Map<string, { data: unknown; isLoading: boolean }>(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => params,
  usePathname: () => `/${params.orgId}/workspace/${params.workspaceId}`,
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => auth,
}));

vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: vi.fn() }) }));

const LOADING = { data: undefined, isLoading: true };

vi.mock("@/hooks/use-scoped-swr", () => ({
  // A null scope is a skipped read — the edit dialog's form reads nothing.
  useScopedSWR: (entity: string, scope: { workspaceId?: string } | null) =>
    reads.get(`${scope?.workspaceId ?? ""}|${entity}`) ?? LOADING,
}));

import { AppSidebar } from "./app-sidebar";

// --- Helpers -----------------------------------------------------------------

const CHAT_LIST = "chat?limit=100";

function setRead(workspaceId: string, entity: string, data: unknown) {
  reads.set(`${workspaceId}|${entity}`, { data, isLoading: false });
}

function chat(id: string, title: string) {
  return {
    id,
    title,
    status: "idle",
    isPinned: false,
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function seedHeader() {
  setRead("", "organizations/org1", { id: "org1", name: "Acme" });
  setRead("", "workspaces", {
    results: [
      { id: "ws1", name: "Alpha", organizationId: "org1" },
      { id: "ws2", name: "Beta", organizationId: "org1" },
    ],
  });
}

function renderSidebar() {
  return render(
    <SidebarProvider>
      <AppSidebar />
    </SidebarProvider>,
  );
}

function search(value: string) {
  fireEvent.change(screen.getByRole("searchbox", { name: "Search chats" }), {
    target: { value },
  });
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

// --- Tests -------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  reads.clear();
  params.workspaceId = "ws1";
  auth.actor = "org-admin";
  auth.ownsWorkspace = true;
  auth.workspaceDelegation = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AppSidebar New chat", () => {
  it("disables New chat once the workspace is known to have no providers", () => {
    setRead("ws1", "providers", { results: [] });
    renderSidebar();

    expect(
      screen.queryByRole("link", { name: "New chat" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
  });

  describe("hint", () => {
    beforeEach(() => {
      // Radix opens the tooltip on real timers and measures it.
      vi.useRealTimers();
    });

    it.each<[string, Actor, boolean, string]>([
      ["an org admin", "org-admin", false, "Add a provider to start a chat"],
      [
        "a Workspace Owner the providers are delegated to",
        "workspace-owner",
        true,
        "Add a provider to start a chat",
      ],
      [
        "a Workspace Owner without the provider delegation",
        "workspace-owner",
        false,
        "Ask an organization admin to add a provider",
      ],
    ])("tells %s why", async (_, actor, delegated, hint) => {
      auth.actor = actor;
      auth.workspaceDelegation = { providerSelfManagement: delegated };
      setRead("ws1", "providers", { results: [] });
      renderSidebar();

      act(() => {
        screen.getByRole("button", { name: "New chat" }).parentElement!.focus();
      });

      expect(await screen.findByRole("tooltip")).toHaveTextContent(hint);
    });
  });

  it.each([
    ["loading", LOADING],
    ["errored", { data: undefined, isLoading: false, error: new Error("500") }],
    ["has providers", { data: { results: [{ id: "p1" }] }, isLoading: false }],
  ])("links to the chat page while the providers read is %s", (_, read) => {
    reads.set("ws1|providers", read);
    renderSidebar();

    expect(screen.getByRole("link", { name: "New chat" })).toHaveAttribute(
      "href",
      "/org1/workspace/ws1/chat",
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});

describe("AppSidebar chat history", () => {
  it("shows a skeleton group until the list first loads", () => {
    seedHeader();
    const { rerender } = renderSidebar();

    expect(
      screen.getByRole("status", { name: "Loading chats" }),
    ).toBeInTheDocument();

    setRead("ws1", CHAT_LIST, { results: [chat("c1", "First chat")] });
    rerender(
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>,
    );

    expect(
      screen.queryByRole("status", { name: "Loading chats" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("First chat")).toBeInTheDocument();
  });

  it("marks an A2A Chat with an icon naming its client", () => {
    seedHeader();
    setRead("ws1", CHAT_LIST, {
      results: [
        {
          ...chat("c1", "Order question"),
          a2aClientName: "Telegram via Hermes",
        },
      ],
    });
    renderSidebar();

    expect(
      screen.getByRole("img", { name: "Over A2A from Telegram via Hermes" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "Over A2A from Telegram via Hermes Order question",
      }),
    ).toBeInTheDocument();
  });

  it("keeps the last list, without a false no-match, while a search is in flight", () => {
    seedHeader();
    setRead("ws1", CHAT_LIST, { results: [chat("c1", "First chat")] });
    renderSidebar();

    search("zzz");

    expect(screen.getByText("First chat")).toBeInTheDocument();
    expect(screen.queryByText(/No chats match/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: "Loading chats" }),
    ).not.toBeInTheDocument();
  });

  it("reports no matches once the search has resolved empty", () => {
    seedHeader();
    setRead("ws1", CHAT_LIST, { results: [chat("c1", "First chat")] });
    setRead("ws1", `${CHAT_LIST}&search=zzz`, { results: [] });
    renderSidebar();

    search("zzz");

    expect(screen.queryByText("First chat")).not.toBeInTheDocument();
    expect(screen.getByText("No chats match “zzz”")).toBeInTheDocument();
  });

  it("never shows the previous Workspace's chats under a new one", () => {
    seedHeader();
    setRead("ws1", CHAT_LIST, { results: [chat("c1", "Alpha chat")] });
    const { rerender } = renderSidebar();
    expect(screen.getByText("Alpha chat")).toBeInTheDocument();

    params.workspaceId = "ws2";
    rerender(
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>,
    );

    expect(screen.queryByText("Alpha chat")).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Loading chats" }),
    ).toBeInTheDocument();
  });
});

describe("AppSidebar workspace switcher", () => {
  it("shows name placeholders while the Organization and Workspaces load", () => {
    renderSidebar();

    expect(screen.getByTestId("org-name-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-name-skeleton")).toBeInTheDocument();
  });

  it("swaps the placeholders for the names once loaded", () => {
    seedHeader();
    renderSidebar();

    expect(screen.queryByTestId("org-name-skeleton")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("workspace-name-skeleton"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  /** Opens the workspace switcher's menu. */
  const openSwitcher = () => {
    const trigger = screen.getByText("Alpha").closest("button")!;
    fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
    fireEvent.click(trigger, { button: 0 });
    return screen.getByRole("menu");
  };

  it("lists Workspaces by name without reordering the cached results", () => {
    const workspaces = {
      results: [
        { id: "ws2", name: "Beta", organizationId: "org1" },
        { id: "ws1", name: "Alpha", organizationId: "org1" },
      ],
    };
    setRead("", "organizations/org1", { id: "org1", name: "Acme" });
    setRead("", "workspaces", workspaces);
    renderSidebar();

    const names = within(openSwitcher())
      .getAllByRole("menuitem")
      .map((item) => item.textContent?.trim())
      .filter((name) => name === "Alpha" || name === "Beta");
    expect(names).toEqual(["Alpha", "Beta"]);
    expect(workspaces.results.map((w) => w.name)).toEqual(["Beta", "Alpha"]);
  });

  it.each([
    ["the Operator", "operator", true],
    ["an Org Admin", "org-admin", true],
    ["a member who owns the Workspace", "workspace-owner", false],
  ] as const)("offers Add workspace to %s (%s): %s", (_who, actor, shown) => {
    auth.actor = actor;
    seedHeader();
    renderSidebar();

    const item = within(openSwitcher()).queryByRole("menuitem", {
      name: /Add workspace/,
    });
    expect(item !== null).toBe(shown);
  });

  describe("Organization settings item", () => {
    beforeEach(() => {
      vi.useRealTimers();
    });

    it.each<Actor>(["operator", "org-admin"])(
      "links the %s to the Organization's settings",
      (actor) => {
        auth.actor = actor;
        seedHeader();
        renderSidebar();

        const item = within(openSwitcher()).getByRole("menuitem", {
          name: "Organization settings",
        });
        expect(item).toHaveAttribute("href", "/org1/settings");
      },
    );

    it.each<Actor>(["workspace-owner", "org-member"])(
      "hides it from the %s",
      (actor) => {
        auth.actor = actor;
        seedHeader();
        renderSidebar();

        expect(
          within(openSwitcher()).queryByRole("menuitem", {
            name: "Organization settings",
          }),
        ).not.toBeInTheDocument();
      },
    );
  });
});

describe("AppSidebar chat actions", () => {
  beforeEach(() => {
    // The writes resolve on real promises; nothing here needs the debounce.
    vi.useRealTimers();
  });

  /** Opens a chat row's menu. */
  const openChatMenu = (title: string) => {
    const trigger = within(screen.getByText(title).closest("li")!).getByRole(
      "button",
      { name: "Chat options" },
    );
    fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
    fireEvent.click(trigger, { button: 0 });
    return screen.getByRole("menu");
  };

  // A field left out of the update is left unchanged, so pinning sends only
  // the pin: resending the title would 400 on one shorter than the minimum.
  it("pins a chat, sending only the pin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    seedHeader();
    setRead("ws1", CHAT_LIST, {
      results: [{ ...chat("c1", "First chat"), tags: ["ops"] }],
    });
    renderSidebar();

    fireEvent.click(
      within(openChatMenu("First chat")).getByRole("menuitem", {
        name: "Pin",
      }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test/organizations/org1/workspaces/ws1/chat/c1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ isPinned: true });
  });

  it("shows a pin at once and reverts it if refused", async () => {
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
    seedHeader();
    setRead("ws1", CHAT_LIST, { results: [chat("c1", "First chat")] });
    renderSidebar();

    fireEvent.click(
      within(openChatMenu("First chat")).getByRole("menuitem", {
        name: "Pin",
      }),
    );

    expect(screen.getByText("Pinned")).toBeInTheDocument();
    await act(async () => refuse());
    expect(screen.queryByText("Pinned")).not.toBeInTheDocument();
  });

  it("keeps a refused delete in its dialog with the backend's message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(409, { error: "Chat is busy" })),
    );
    seedHeader();
    setRead("ws1", CHAT_LIST, { results: [chat("c1", "First chat")] });
    renderSidebar();

    fireEvent.click(
      within(openChatMenu("First chat")).getByRole("menuitem", {
        name: "Delete",
      }),
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Chat is busy",
    );
  });

  // The backend refuses every one of these to anyone but the Workspace Owner
  // — an Org Admin included — so offering them would only produce an error.
  it("offers a non-owner no Pin, Edit or Delete", () => {
    auth.ownsWorkspace = false;
    seedHeader();
    setRead("ws1", CHAT_LIST, {
      results: [
        chat("c1", "Untagged chat"),
        { ...chat("c2", "Tagged chat"), tags: ["ops"] },
      ],
    });
    renderSidebar();

    expect(
      within(screen.getByText("Untagged chat").closest("li")!).queryByRole(
        "button",
        { name: "Chat options" },
      ),
    ).not.toBeInTheDocument();
    const menu = openChatMenu("Tagged chat");
    expect(within(menu).getByText("ops")).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem")).not.toBeInTheDocument();
  });
});
