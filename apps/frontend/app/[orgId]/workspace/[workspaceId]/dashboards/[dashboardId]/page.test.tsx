import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { Suspense } from "react";
import type { Dashboard, Widget } from "@platypus/schemas";

const ORG_ID = "org-1";
const WS_ID = "ws-1";
const DASHBOARD_ID = "dash-1";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "http://test",
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

const { toastError, mutateWidgets, mutateDashboard } = vi.hoisted(() => ({
  toastError: vi.fn(),
  mutateWidgets: vi.fn(),
  mutateDashboard: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}));

// The real ResponsiveGridLayout drags via pointer gestures that jsdom can't
// simulate; a drag/resize only ever updates local staged state (never hits
// the network — see saveEdit), so it isn't part of what this file verifies.
vi.mock("react-grid-layout", () => ({
  ResponsiveGridLayout: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

let dashboardData: Dashboard | undefined;
let widgetsData: { results: Widget[] } | undefined;

vi.mock("swr", () => ({
  __esModule: true,
  default: (key: string | null) => {
    if (!key) return { data: undefined, mutate: vi.fn() };
    if (key.endsWith("/widgets")) {
      return { data: widgetsData, mutate: mutateWidgets };
    }
    if (key.endsWith(`/workspaces/${WS_ID}/dashboards`)) {
      return {
        data: { results: dashboardData ? [dashboardData] : [] },
        mutate: vi.fn(),
      };
    }
    return { data: dashboardData, mutate: mutateDashboard };
  },
}));

import DashboardPage from "./page";

// --- Fixtures ------------------------------------------------------------

const baseDashboard = (): Dashboard => ({
  id: DASHBOARD_ID,
  workspaceId: WS_ID,
  name: "Test Dashboard",
  description: null,
  desktopLayout: [{ i: "w-1", x: 0, y: 0, w: 3, h: 5 }],
  mobileLayout: [],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
});

const baseWidget = (): Widget => ({
  id: "w-1",
  dashboardId: DASHBOARD_ID,
  type: "text",
  title: "My Text Widget",
  data: { content: "hello" },
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
});

/** Routes a stubbed `fetch` by method/URL shape, so each mutation's success
 * or failure can be controlled independently per test. */
function stubFetch(
  overrides: Partial<{
    addWidget: boolean;
    deleteWidget: boolean;
    widgetPut: boolean;
    layoutPut: boolean;
  }> = {},
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && url.endsWith("/widgets")) {
      const ok = overrides.addWidget ?? true;
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () =>
          ok
            ? {
                id: "new-widget",
                dashboardId: DASHBOARD_ID,
                type: "metric",
                title: "New Widget",
                data: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              }
            : { error: "Something went wrong" },
      } as unknown as Response;
    }
    if (method === "DELETE") {
      const ok = overrides.deleteWidget ?? true;
      return { ok, status: ok ? 200 : 500, json: async () => ({}) } as Response;
    }
    if (method === "PUT" && /\/widgets\/[^/]+$/.test(url)) {
      const ok = overrides.widgetPut ?? true;
      return { ok, status: ok ? 200 : 500, json: async () => ({}) } as Response;
    }
    if (method === "PUT") {
      const ok = overrides.layoutPut ?? true;
      return { ok, status: ok ? 200 : 500, json: async () => ({}) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderDashboard() {
  await act(async () => {
    render(
      <Suspense>
        <DashboardPage
          params={Promise.resolve({
            orgId: ORG_ID,
            workspaceId: WS_ID,
            dashboardId: DASHBOARD_ID,
          })}
        />
      </Suspense>,
    );
  });
  await screen.findByText("Test Dashboard");
}

const clickEdit = () =>
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));

const clickWidgetPencil = () => {
  const button = document.querySelector("button:has(svg.lucide-pencil)");
  if (!button) throw new Error("widget edit toggle not found");
  fireEvent.click(button);
};

const clickWidgetTrash = () => {
  const button = document.querySelector("button:has(svg.lucide-trash-2)");
  if (!button) throw new Error("widget delete button not found");
  fireEvent.click(button);
};

const widgetSaveButton = () => {
  const buttons = screen.getAllByRole("button", { name: "Save" });
  return buttons[buttons.length - 1];
};

describe("Dashboard editor mutations", () => {
  beforeEach(() => {
    dashboardData = baseDashboard();
    widgetsData = { results: [baseWidget()] };
    mutateWidgets.mockClear();
    mutateDashboard.mockClear();
    toastError.mockClear();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // The worst of the five: closing the editor unconditionally makes a failed
  // save look identical to a successful one and silently drops the user's edit.
  describe("saving widget data", () => {
    it("closes the editor and refreshes the widget list on success", async () => {
      await renderDashboard();
      clickEdit();
      clickWidgetPencil();
      expect(
        screen.getByPlaceholderText("Markdown content…"),
      ).toBeInTheDocument();

      stubFetch({ widgetPut: true });
      fireEvent.click(widgetSaveButton());

      await waitFor(() => expect(mutateWidgets).toHaveBeenCalled());
      expect(
        screen.queryByPlaceholderText("Markdown content…"),
      ).not.toBeInTheDocument();
      expect(toastError).not.toHaveBeenCalled();
    });

    it("keeps the editor open and reports the error when the save fails", async () => {
      await renderDashboard();
      clickEdit();
      clickWidgetPencil();

      stubFetch({ widgetPut: false });
      fireEvent.click(widgetSaveButton());

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(
        screen.getByPlaceholderText("Markdown content…"),
      ).toBeInTheDocument();
      expect(mutateWidgets).not.toHaveBeenCalled();
    });
  });

  describe("saving the dashboard (layout + pending widget deletions)", () => {
    it("exits edit mode and refreshes on success", async () => {
      await renderDashboard();
      clickEdit();

      stubFetch({ layoutPut: true });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Edit" }),
        ).toBeInTheDocument(),
      );
      expect(mutateDashboard).toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
    });

    it("does not leave the UI claiming the layout was persisted when the layout PUT fails", async () => {
      await renderDashboard();
      clickEdit();

      stubFetch({ layoutPut: false });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(
        screen.queryByRole("button", { name: "Edit" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Cancel" }),
      ).toBeInTheDocument();
      expect(mutateDashboard).not.toHaveBeenCalled();
    });

    it("does not attempt the layout PUT, and stays in edit mode, when deleting a widget fails", async () => {
      await renderDashboard();
      clickEdit();
      clickWidgetTrash();

      const fetchMock = stubFetch({ deleteWidget: false });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(
        screen.getByRole("button", { name: "Cancel" }),
      ).toBeInTheDocument();
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === "PUT"),
      ).toBe(false);
    });
  });

  describe("adding a widget", () => {
    it("shows an error and keeps the dialog open when creation fails", async () => {
      await renderDashboard();
      clickEdit();
      fireEvent.click(screen.getByRole("button", { name: /add widget/i }));
      fireEvent.change(screen.getByPlaceholderText("Widget title"), {
        target: { value: "My New Widget" },
      });

      stubFetch({ addWidget: false });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(screen.getByDisplayValue("My New Widget")).toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  describe("cancelling an edit", () => {
    it("stays in edit mode and reports the error when undoing a pending addition fails", async () => {
      await renderDashboard();
      clickEdit();

      stubFetch({ addWidget: true });
      fireEvent.click(screen.getByRole("button", { name: /add widget/i }));
      fireEvent.change(screen.getByPlaceholderText("Widget title"), {
        target: { value: "My New Widget" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );

      stubFetch({ deleteWidget: false });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(
        screen.getByRole("button", { name: "Cancel" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Edit" }),
      ).not.toBeInTheDocument();
    });
  });
});
