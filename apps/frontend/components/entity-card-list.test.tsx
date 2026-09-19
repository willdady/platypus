import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import {
  installRadixPointerPolyfills,
  openDropdownMenu as openMenu,
} from "@/lib/test-utils";

beforeAll(installRadixPointerPolyfills);

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ user: { id: "u1" } }),
}));

type EntityCard = { id: string; name: string; description?: string | null };

// The list this component renders. Set per test.
let items: EntityCard[] = [];
const mutateSpy = vi.fn();

vi.mock("swr", () => ({
  __esModule: true,
  default: () => ({
    data: { results: items },
    error: undefined,
    isLoading: false,
    mutate: mutateSpy,
  }),
}));

import { BoardsList } from "./boards-list";
import { DashboardsList } from "./dashboards-list";

// --- Fixtures ----------------------------------------------------------------

const card: EntityCard = {
  id: "r1",
  name: "Revenue",
  description: "Revenue overview",
};

const RESOURCES: {
  name: string;
  List: ComponentType<{ orgId: string; workspaceId: string }>;
  entity: string;
  confirmPhrase: string;
}[] = [
  {
    name: "boards",
    List: BoardsList,
    entity: "boards",
    confirmPhrase: "delete board",
  },
  {
    name: "dashboards",
    List: DashboardsList,
    entity: "dashboards",
    confirmPhrase: "delete dashboard",
  },
];

// --- Helpers -----------------------------------------------------------------

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

async function openDeleteDialog(confirmPhrase: string) {
  openMenu();
  fireEvent.click(screen.getByText("Delete"));
  // The confirmation input must be typed before the destructive button enables.
  fireEvent.change(
    screen.getByPlaceholderText(`Type '${confirmPhrase}' to confirm`),
    { target: { value: confirmPhrase } },
  );
}

afterEach(() => {
  items = [];
  mutateSpy.mockClear();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe.each(RESOURCES)("$name list", ({ List, entity, confirmPhrase }) => {
  it("renders each card as a link to its detail page", () => {
    items = [card];

    render(<List orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText("Revenue").closest("a")).toHaveAttribute(
      "href",
      `/org1/workspace/ws1/${entity}/r1`,
    );
    expect(screen.getByText("Revenue overview")).toBeInTheDocument();
  });

  it("deletes through the request module and revalidates on success", async () => {
    items = [card];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<List orgId="org1" workspaceId="ws1" />);
    await openDeleteDialog(confirmPhrase);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mutateSpy).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      `http://test/organizations/org1/workspaces/ws1/${entity}/r1`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("surfaces the backend's reason inline and does not revalidate when delete is refused", async () => {
    items = [card];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(409, { error: `This ${entity} is in use` }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<List orgId="org1" workspaceId="ws1" />);
    await openDeleteDialog(confirmPhrase);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByText(`This ${entity} is in use`)).toBeInTheDocument(),
    );
    expect(mutateSpy).not.toHaveBeenCalled();
    // The dialog stays open on a refused delete, letting the user retry.
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });
});
