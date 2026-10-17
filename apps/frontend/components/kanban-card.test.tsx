import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { KanbanCard, KanbanLabel } from "@platypus/schemas";
import { KanbanCardComponent } from "./kanban-card";
import type { Serialized } from "@/lib/api-write";

function makeCard(
  overrides: Partial<Serialized<KanbanCard>> = {},
): Serialized<KanbanCard> {
  return {
    id: "card-1",
    columnId: "col-1",
    title: "A card",
    body: null,
    labelIds: [],
    assignees: [],
    dueDate: null,
    priority: "none",
    position: 1,
    resolvedAssignees: [],
    commentCount: 0,
    createdAt: new Date("2026-01-01").toISOString(),
    updatedAt: new Date("2026-01-01").toISOString(),
    ...overrides,
  };
}

function renderCard(card: Serialized<KanbanCard>, labels: KanbanLabel[] = []) {
  const onCardClick = vi.fn();
  render(
    <KanbanCardComponent
      card={card}
      labels={labels}
      onCardClick={onCardClick}
    />,
  );
  return { onCardClick, card: screen.getByRole("button", { name: /A card/ }) };
}

afterEach(() => vi.useRealTimers());

describe("KanbanCard keyboard", () => {
  it("opens on Enter", () => {
    const { onCardClick, card } = renderCard(makeCard());

    fireEvent.keyDown(card, { key: "Enter" });

    expect(onCardClick).toHaveBeenCalledOnce();
  });

  it("does not open on Space, which picks the card up to drag", () => {
    const { onCardClick, card } = renderCard(makeCard());

    fireEvent.keyDown(card, { key: " ", code: "Space" });

    expect(onCardClick).not.toHaveBeenCalled();
  });
});

describe("KanbanCard status", () => {
  it("says a past due date is overdue in words", () => {
    vi.useFakeTimers({ now: new Date("2026-03-10T12:00:00Z") });
    renderCard(makeCard({ dueDate: "2026-03-01T00:00:00Z" }));

    expect(screen.getByText(/Overdue/)).toBeInTheDocument();
  });

  it("says a due date within a day is due soon in words", () => {
    vi.useFakeTimers({ now: new Date("2026-03-10T12:00:00Z") });
    renderCard(makeCard({ dueDate: "2026-03-11T00:00:00Z" }));

    expect(screen.getByText(/Due soon/)).toBeInTheDocument();
  });

  it("names the priority, not just its border colour", () => {
    renderCard(makeCard({ priority: "urgent" }));

    expect(screen.getByText("Priority: Urgent")).toBeInTheDocument();
  });

  it("names no priority when there is none", () => {
    renderCard(makeCard({ priority: "none" }));

    expect(screen.queryByText(/Priority:/)).not.toBeInTheDocument();
  });

  it("picks a label's text colour for contrast with its background", () => {
    renderCard(makeCard({ labelIds: ["l1", "l2"] }), [
      { id: "l1", name: "Light", color: "#fde047" },
      { id: "l2", name: "Dark", color: "#1e3a8a" },
    ] as KanbanLabel[]);

    expect(screen.getByText("Light")).toHaveStyle({ color: "#0a0a0a" });
    expect(screen.getByText("Dark")).toHaveStyle({ color: "#ffffff" });
  });
});
