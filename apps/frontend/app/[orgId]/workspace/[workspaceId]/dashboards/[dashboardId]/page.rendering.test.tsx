import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { Suspense } from "react";
import type { Dashboard, Widget } from "@platypus/schemas";
import { installResizeObserverStub } from "@/lib/test-utils";

const ORG_ID = "org-1";
const WS_ID = "ws-1";
const DASHBOARD_ID = "dash-1";

// `widgetRender` is called once per tile body render, so its call count is the
// number of Widgets that actually re-rendered.
const { widgetRender, swrCalls, mutateWidgets, mutateDashboard, gridHandlers } =
  vi.hoisted(() => ({
    widgetRender: vi.fn(),
    swrCalls: [] as Array<{
      key: string;
      options?: { refreshInterval?: number };
    }>,
    mutateWidgets: vi.fn(),
    mutateDashboard: vi.fn(),
    gridHandlers: {
      onDragStart: undefined,
      onDragStop: undefined,
    } as {
      onDragStart?: () => void;
      onDragStop?: (
        layout: readonly {
          i: string;
          x: number;
          y: number;
          w: number;
          h: number;
        }[],
      ) => void;
    },
  }));

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("react-grid-layout", () => ({
  ResponsiveGridLayout: ({
    children,
    onDragStart,
    onDragStop,
  }: {
    children?: React.ReactNode;
    onDragStart?: () => void;
    onDragStop?: typeof gridHandlers.onDragStop;
  }) => {
    gridHandlers.onDragStart = onDragStart;
    gridHandlers.onDragStop = onDragStop;
    return <div>{children}</div>;
  },
}));

// Replace every widget body with a counting stub. The registry still supplies
// the icons, so the tile chrome renders as it does in the app.
vi.mock("@/components/widgets", async () => {
  const lucide = await import("lucide-react");
  const Stub = () => {
    widgetRender();
    return null;
  };
  return {
    widgetTypeUi: {
      metric: { icon: lucide.Hash, component: Stub },
      text: { icon: lucide.AlignLeft, component: Stub },
      image: { icon: lucide.ImageIcon, component: Stub },
      embed: { icon: lucide.AppWindow, component: Stub },
      weather: { icon: lucide.CloudSun, component: Stub },
      "line-chart": { icon: lucide.ChartLine, component: Stub },
      "pie-chart": { icon: lucide.ChartPie, component: Stub },
      "bar-chart": { icon: lucide.ChartColumnIncreasing, component: Stub },
    },
  };
});

let dashboardData: Dashboard | undefined;
let widgetsData: { results: Widget[] } | undefined;

vi.mock("swr", () => ({
  __esModule: true,
  default: (
    key: string | null,
    _fetcher: unknown,
    options?: { refreshInterval?: number },
  ) => {
    if (!key) return { data: undefined, mutate: vi.fn() };
    swrCalls.push({ key, options });
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

const baseDashboard = (): Dashboard => ({
  id: DASHBOARD_ID,
  workspaceId: WS_ID,
  name: "Test Dashboard",
  description: null,
  desktopLayout: [],
  mobileLayout: [],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
});

const textWidget = (id: string, title: string): Widget => ({
  id,
  dashboardId: DASHBOARD_ID,
  type: "text",
  title,
  data: { content: "" },
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
});

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

describe("Dashboard render stability", () => {
  beforeEach(() => {
    dashboardData = baseDashboard();
    widgetsData = { results: [textWidget("w-1", "First")] };
    swrCalls.length = 0;
    widgetRender.mockClear();
    installResizeObserverStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("polls the dashboard in view but not the switcher list", async () => {
    await renderDashboard();

    const list = swrCalls.find((call) =>
      call.key.endsWith(`/workspaces/${WS_ID}/dashboards`),
    );
    const dashboard = swrCalls.find((call) =>
      call.key.endsWith(`/dashboards/${DASHBOARD_ID}`),
    );
    const widgets = swrCalls.find((call) => call.key.endsWith("/widgets"));

    expect(dashboard?.options?.refreshInterval).toBe(5000);
    expect(widgets?.options?.refreshInterval).toBe(5000);
    expect(list?.options).toBeUndefined();
  });

  it("re-renders only the widget being edited", async () => {
    dashboardData = {
      ...baseDashboard(),
      desktopLayout: [
        { i: "w-1", x: 0, y: 0, w: 3, h: 5 },
        { i: "w-2", x: 3, y: 0, w: 3, h: 5 },
      ],
    };
    widgetsData = {
      results: [textWidget("w-1", "First"), textWidget("w-2", "Second")],
    };
    await renderDashboard();

    // Entering edit mode changes a prop shared by every tile.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    widgetRender.mockClear();

    const pencil = document.querySelector("button:has(svg.lucide-pencil)");
    if (!pencil) throw new Error("widget edit toggle not found");
    fireEvent.click(pencil);

    expect(widgetRender).toHaveBeenCalledTimes(1);
  });

  it("does not re-render widget tiles while the grid reports a drag", async () => {
    dashboardData = {
      ...baseDashboard(),
      desktopLayout: [
        { i: "w-1", x: 0, y: 0, w: 3, h: 5 },
        { i: "w-2", x: 3, y: 0, w: 3, h: 5 },
      ],
    };
    widgetsData = {
      results: [textWidget("w-1", "First"), textWidget("w-2", "Second")],
    };
    await renderDashboard();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    widgetRender.mockClear();

    act(() => {
      gridHandlers.onDragStart?.();
      gridHandlers.onDragStop?.([
        { i: "w-1", x: 0, y: 1, w: 3, h: 5 },
        { i: "w-2", x: 3, y: 0, w: 3, h: 5 },
      ]);
    });

    expect(widgetRender).not.toHaveBeenCalled();
  });
});
