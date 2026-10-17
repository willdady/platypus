import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
} from "@/test/list-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { BoardsList } from "./boards-list";
import { DashboardsList } from "./dashboards-list";
import { EntityCardList } from "./entity-card-list";

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

// --- Tests -------------------------------------------------------------------

describe.each(RESOURCES)("$name list", ({ List, entity, confirmPhrase }) => {
  /** Renders the list with `cards` in it, optionally opening the row menu. */
  const renderCards = (cards: EntityCard[], menuItem?: string) => {
    mockScopedSWR({ [`/${entity}`]: cards }, { strict: true });
    return renderList(<List orgId="org1" workspaceId="ws1" />, menuItem);
  };

  /** Opens the delete dialog and types the phrase that enables its button. */
  const armDelete = async (cards: EntityCard[]) => {
    await renderCards(cards, "Delete");
    fireEvent.change(
      screen.getByPlaceholderText(`Type '${confirmPhrase}' to confirm`),
      { target: { value: confirmPhrase } },
    );
  };

  it("renders each card as a link to its detail page", async () => {
    await renderCards([card]);

    expect(screen.getByText("Revenue").closest("a")).toHaveAttribute(
      "href",
      `/org1/workspace/ws1/${entity}/r1`,
    );
    expect(screen.getByText("Revenue overview")).toBeInTheDocument();
  });

  it("deletes through the request module and revalidates on success", async () => {
    const fetchMock = stubAcceptedSave();

    await armDelete([card]);
    await confirmDialog("Delete");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      `http://test/organizations/org1/workspaces/ws1/${entity}/r1`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("surfaces the backend's reason inline and does not revalidate when delete is refused", async () => {
    stubRejectedSave(`This ${entity} is in use`, 409);

    await armDelete([card]);
    await confirmDialog("Delete");

    expect(
      await screen.findByText(`This ${entity} is in use`),
    ).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
    // The dialog stays open on a refused delete, letting the user retry.
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("says when the workspace has none", async () => {
    await renderCards([]);

    expect(screen.getByText(/^No .* yet\.$/)).toBeInTheDocument();
  });

  it("surfaces a failed read rather than rendering an empty list", async () => {
    mockScopedSWR(
      { [`/${entity}`]: { error: new Error("500") } },
      { strict: true },
    );
    await renderList(<List orgId="org1" workspaceId="ws1" />);

    expect(
      screen.getByText(new RegExp(`Failed to load ${entity}`)),
    ).toBeInTheDocument();
  });

  it("shows the loading state while the read is in flight", async () => {
    mockScopedSWR({ [`/${entity}`]: { isLoading: true } }, { strict: true });
    await renderList(<List orgId="org1" workspaceId="ws1" />);

    expect(
      screen.getByRole("status", { name: `Loading ${entity}` }),
    ).toHaveAttribute("aria-busy", "true");
  });
});

describe("EntityCardList slots", () => {
  const item = { id: "i1", name: "Alpha", description: "First" };

  /** Renders the loaded list with `item` and the given slots. */
  const renderCards = (
    slots: Partial<Parameters<typeof EntityCardList<typeof item>>[0]> = {},
  ) =>
    render(
      <EntityCardList
        items={[item]}
        isLoading={false}
        error={undefined}
        subject="widgets"
        skeleton={<p>Skeleton</p>}
        empty={<p>Nothing here</p>}
        {...slots}
      />,
    );

  const card = () => screen.getByText("Alpha").closest('[data-slot="item"]');

  it("renders `skeleton` in a region named for the subject while loading", () => {
    renderCards({ isLoading: true });

    expect(
      screen.getByRole("status", { name: "Loading widgets" }),
    ).toHaveTextContent("Skeleton");
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  });

  it("names the subject in a failed read", () => {
    renderCards({ error: new Error("500") });

    expect(screen.getByText(/Failed to load widgets/)).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  });

  it("renders `empty` when there are no items", () => {
    renderCards({ items: [] });

    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("renders each item's name and description", () => {
    renderCards();

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("First")).toBeInTheDocument();
  });

  it("links the card to `href`", () => {
    renderCards({ href: (i) => `/things/${i.id}` });

    expect(card()).toHaveAttribute("href", "/things/i1");
  });

  it("renders a plain card without `href`", () => {
    renderCards();

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(card()?.tagName).toBe("DIV");
  });

  it("renders `media` before the content", () => {
    renderCards({ media: (i) => <span>Avatar of {i.name}</span> });

    expect(
      screen.getByText("Avatar of Alpha").nextElementSibling,
    ).toHaveAttribute("data-slot", "item-content");
  });

  it("renders `meta` under the description", () => {
    renderCards({ meta: (i) => <span>Meta of {i.name}</span> });

    expect(screen.getByText("First").nextElementSibling).toHaveTextContent(
      "Meta of Alpha",
    );
  });

  it("renders `menu` in the card's actions, and no actions without it", () => {
    const { unmount } = renderCards();
    expect(
      card()?.querySelector('[data-slot="item-actions"]'),
    ).not.toBeInTheDocument();
    unmount();

    renderCards({ menu: (i) => <button>Menu for {i.name}</button> });
    expect(
      card()?.querySelector('[data-slot="item-actions"]'),
    ).toHaveTextContent("Menu for Alpha");
  });

  it("lets `wrap` surround the card and add classes and meta", () => {
    renderCards({
      wrap: (i, cardFor) => (
        <section aria-label={`Wrapper of ${i.name}`}>
          {cardFor({ className: "border-warning", meta: <span>Extra</span> })}
        </section>
      ),
    });

    expect(
      screen.getByRole("region", { name: "Wrapper of Alpha" }),
    ).toContainElement(card() as HTMLElement);
    expect(card()).toHaveClass("border-warning");
    expect(screen.getByText("Extra")).toBeInTheDocument();
  });
});
