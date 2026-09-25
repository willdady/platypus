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
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  installMatchMediaStub,
  installRadixPointerPolyfills,
  jsonResponse,
} from "@/lib/test-utils";

// --- Module mocks ------------------------------------------------------------

const { params, reads } = vi.hoisted(() => ({
  params: { orgId: "org1", workspaceId: "ws1" },
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
}));

vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: vi.fn() }) }));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const LOADING = { data: undefined, isLoading: true };

vi.mock("@/hooks/use-scoped-swr", () => ({
  useScopedSWR: (entity: string, scope: { workspaceId?: string }) =>
    reads.get(`${scope.workspaceId ?? ""}|${entity}`) ?? LOADING,
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
  fireEvent.change(screen.getByPlaceholderText("Search chats..."), {
    target: { value },
  });
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

// --- Tests -------------------------------------------------------------------

beforeAll(installMatchMediaStub);

beforeEach(() => {
  vi.useFakeTimers();
  reads.clear();
  params.workspaceId = "ws1";
});

afterEach(() => {
  vi.useRealTimers();
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
});

describe("AppSidebar chat actions", () => {
  beforeEach(() => {
    // The writes resolve on real promises; nothing here needs the debounce.
    vi.useRealTimers();
    installRadixPointerPolyfills();
  });

  afterEach(() => vi.unstubAllGlobals());

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

  // The update is a full PUT, so pinning must carry the title and tags over
  // rather than blank them.
  it("pins a chat, keeping its title and tags", async () => {
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
    expect(JSON.parse(init.body)).toEqual({
      workspaceId: "ws1",
      title: "First chat",
      isPinned: true,
      tags: ["ops"],
    });
  });
});
