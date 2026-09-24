import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  confirmDialog,
  stubAcceptedSave,
  stubRejectedSave,
  mutate,
} from "@/lib/list-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { BoardsList } from "./boards-list";
import { DashboardsList } from "./dashboards-list";

// --- Fixtures ----------------------------------------------------------------

type EntityCard = { id: string; name: string; description?: string | null };

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

beforeEach(resetListHarness);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe.each(RESOURCES)("$name list", ({ List, entity, confirmPhrase }) => {
  /** Renders the list with `cards` in it, optionally opening the row menu. */
  const renderCards = (cards: EntityCard[], menuItem?: string) => {
    mockScopedSWR({ [`/${entity}`]: cards });
    return renderList(<List orgId="org1" workspaceId="ws1" />, menuItem);
  };

  /** Opens the delete dialog and types the phrase that enables its button. */
  const armDelete = (cards: EntityCard[]) => {
    renderCards(cards, "Delete");
    fireEvent.change(
      screen.getByPlaceholderText(`Type '${confirmPhrase}' to confirm`),
      { target: { value: confirmPhrase } },
    );
  };

  it("renders each card as a link to its detail page", () => {
    renderCards([card]);

    expect(screen.getByText("Revenue").closest("a")).toHaveAttribute(
      "href",
      `/org1/workspace/ws1/${entity}/r1`,
    );
    expect(screen.getByText("Revenue overview")).toBeInTheDocument();
  });

  it("deletes through the request module and revalidates on success", async () => {
    const fetchMock = stubAcceptedSave();

    armDelete([card]);
    await confirmDialog("Delete");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      `http://test/organizations/org1/workspaces/ws1/${entity}/r1`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("surfaces the backend's reason inline and does not revalidate when delete is refused", async () => {
    stubRejectedSave(`This ${entity} is in use`, 409);

    armDelete([card]);
    await confirmDialog("Delete");

    await waitFor(() =>
      expect(screen.getByText(`This ${entity} is in use`)).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
    // The dialog stays open on a refused delete, letting the user retry.
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  // The page around it owns the empty copy, so the list renders nothing at all
  // rather than a second, competing empty state.
  it("renders nothing when the workspace has none", () => {
    const { container } = renderCards([]);

    expect(container).toBeEmptyDOMElement();
  });

  it("surfaces a failed read rather than rendering an empty list", () => {
    mockScopedSWR({ [`/${entity}`]: { error: new Error("500") } });
    renderList(<List orgId="org1" workspaceId="ws1" />);

    expect(
      screen.getByText(new RegExp(`Failed to load ${entity}`)),
    ).toBeInTheDocument();
  });

  it("shows the loading state while the read is in flight", () => {
    mockScopedSWR({ [`/${entity}`]: { isLoading: true } });
    renderList(<List orgId="org1" workspaceId="ws1" />);

    expect(
      screen.getByRole("status", { name: `Loading ${entity}` }),
    ).toHaveAttribute("aria-busy", "true");
  });
});
