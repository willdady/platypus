import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Dashboard } from "@platypus/schemas";
import {
  installRadixPointerPolyfills,
  openDropdownMenu as openMenu,
} from "@/lib/test-utils";

beforeAll(installRadixPointerPolyfills);

// --- Module mocks ------------------------------------------------------------

vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "http://test",
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));

// The `GET .../dashboards` list this component renders. Set per test.
let dashboards: Dashboard[] = [];
const mutateSpy = vi.fn();

vi.mock("swr", () => ({
  __esModule: true,
  default: () => ({
    data: { results: dashboards },
    isLoading: false,
    mutate: mutateSpy,
  }),
}));

import { DashboardsList } from "./dashboards-list";

// --- Helpers -----------------------------------------------------------------

const dashboard: Dashboard = {
  id: "d1",
  name: "Revenue",
  description: "Revenue overview",
} as unknown as Dashboard;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

async function openDeleteDialog() {
  openMenu();
  fireEvent.click(screen.getByText("Delete"));
  // The confirmation input must be typed before the destructive button enables.
  fireEvent.change(
    screen.getByPlaceholderText("Type 'delete dashboard' to confirm"),
    { target: { value: "delete dashboard" } },
  );
}

afterEach(() => {
  dashboards = [];
  mutateSpy.mockClear();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("DashboardsList delete", () => {
  it("deletes through the request module and revalidates on success", async () => {
    dashboards = [dashboard];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<DashboardsList orgId="org1" workspaceId="ws1" />);
    await openDeleteDialog();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mutateSpy).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/dashboards/d1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("surfaces the backend's reason inline and does not revalidate when delete is refused", async () => {
    dashboards = [dashboard];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { error: "Dashboard is in use" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<DashboardsList orgId="org1" workspaceId="ws1" />);
    await openDeleteDialog();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByText("Dashboard is in use")).toBeInTheDocument(),
    );
    expect(mutateSpy).not.toHaveBeenCalled();
    // The dialog stays open on a refused delete, letting the user retry.
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });
});
