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
  queryParam: string;
}[] = [
  {
    name: "boards",
    List: BoardsList,
    entity: "boards",
    confirmPhrase: "delete board",
    queryParam: "boardQuery",
  },
  {
    name: "dashboards",
    List: DashboardsList,
    entity: "dashboards",
    confirmPhrase: "delete dashboard",
    queryParam: "dashboardQuery",
  },
];

beforeEach(resetListHarness);

// --- Tests -------------------------------------------------------------------

describe.each(RESOURCES)(
  "$name list",
  ({ List, entity, confirmPhrase, queryParam }) => {
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
      expect(
        screen.getByRole("button", { name: "Delete" }),
      ).toBeInTheDocument();
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

    describe("search", () => {
      const cards = [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Bravo" },
      ];
      const searchbox = () =>
        screen.getByRole("searchbox", { name: `Search ${entity}` });
      const search = (text: string) =>
        fireEvent.change(searchbox(), { target: { value: text } });

      it("narrows the cards to the names that fuzzily match", async () => {
        await renderCards(cards);

        search("alp");

        expect(screen.getByText("Alpha")).toBeInTheDocument();
        expect(screen.queryByText("Bravo")).not.toBeInTheDocument();
      });

      it("says none match, rather than none exist, with the search still shown", async () => {
        await renderCards(cards);

        search("zzz");

        expect(
          screen.getByText(`No ${entity} match your filters.`),
        ).toBeInTheDocument();
        expect(screen.queryByText(/yet\.$/)).not.toBeInTheDocument();
        expect(searchbox()).toHaveValue("zzz");
      });

      it("offers no search when the workspace has none", async () => {
        await renderCards([]);

        expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
      });

      it("writes the search to its own param, leaving an empty one out", async () => {
        const pushState = vi.spyOn(window.history, "pushState");
        await renderCards(cards);

        search("alp");
        expect(window.location.search).toBe(`?${queryParam}=alp`);

        search("  ");
        expect(window.location.search).toBe("");
        expect(pushState).not.toHaveBeenCalled();
      });

      it("reads the search back from its param", async () => {
        window.history.replaceState(null, "", `?${queryParam}=br`);
        await renderCards(cards);

        expect(searchbox()).toHaveValue("br");
        expect(screen.getByText("Bravo")).toBeInTheDocument();
        expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
      });

      it("ignores the other list's param", async () => {
        const other = RESOURCES.find((r) => r.entity !== entity)!;
        window.history.replaceState(null, "", `?${other.queryParam}=br`);
        await renderCards(cards);

        expect(searchbox()).toHaveValue("");
        expect(screen.getByText("Alpha")).toBeInTheDocument();
      });
    });
  },
);

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

  it("reserves a two-line description box, with the full text on hover", () => {
    renderCards();

    const description = screen.getByText("First");
    expect(description).toHaveClass("line-clamp-2", "min-h-[2lh]");
    expect(description).toHaveAttribute("title", "First");
  });

  it("clamps and reserves the description to `descriptionLines`", () => {
    renderCards({ descriptionLines: 3 });

    expect(screen.getByText("First")).toHaveClass(
      "line-clamp-3",
      "min-h-[3lh]",
    );
    expect(screen.getByText("First")).not.toHaveClass("line-clamp-2");
  });

  it("keeps the description box when there is no description", () => {
    renderCards({ items: [{ ...item, description: "" }] });

    const description = screen.getByRole("paragraph");
    expect(description).toHaveClass("min-h-[2lh]");
    expect(description).not.toHaveAttribute("title");
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
