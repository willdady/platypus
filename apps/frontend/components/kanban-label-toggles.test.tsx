import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { KanbanLabel } from "@platypus/schemas";
import { KanbanLabelToggles } from "./kanban-label-toggles";

const labels: KanbanLabel[] = [
  { id: "l1", name: "Bug", color: "#ef4444" },
  { id: "l2", name: "UI", color: "#3b82f6" },
];

function renderToggles({
  selectedIds = [] as string[],
  onChange = vi.fn<(selectedIds: string[]) => void>(),
} = {}) {
  return render(
    <>
      <p id="labels-label">Labels</p>
      <KanbanLabelToggles
        labels={labels}
        selectedIds={selectedIds}
        onChange={onChange}
        labelledBy="labels-label"
      />
    </>,
  );
}

describe("KanbanLabelToggles", () => {
  it("groups the toggles under an accessible name", () => {
    renderToggles();

    const group = screen.getByRole("group", { name: "Labels" });
    expect(
      within(group).getByRole("button", { name: "Bug" }),
    ).toBeInTheDocument();
    expect(
      within(group).getByRole("button", { name: "UI" }),
    ).toBeInTheDocument();
  });

  it("exposes each label's pressed state and dims the unselected ones", () => {
    renderToggles({ selectedIds: ["l1"] });

    const selected = screen.getByRole("button", { name: "Bug" });
    const unselected = screen.getByRole("button", { name: "UI" });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(unselected).toHaveAttribute("aria-pressed", "false");
    expect(unselected).toHaveClass("opacity-40");
    expect(selected).not.toHaveClass("opacity-40");
  });

  it("adds an unselected label to the selection when it is clicked", () => {
    const onChange = vi.fn<(selectedIds: string[]) => void>();
    renderToggles({ selectedIds: ["l1"], onChange });

    fireEvent.click(screen.getByRole("button", { name: "UI" }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith(["l1", "l2"]);
  });

  it("takes a selected label out of the selection when it is clicked", () => {
    const onChange = vi.fn<(selectedIds: string[]) => void>();
    renderToggles({ selectedIds: ["l1", "l2"], onChange });

    fireEvent.click(screen.getByRole("button", { name: "Bug" }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith(["l2"]);
  });

  it("keeps the label colours", () => {
    renderToggles();

    expect(screen.getByRole("button", { name: "Bug" })).toHaveStyle({
      backgroundColor: "#ef4444",
      color: "#0a0a0a",
    });
  });

  it("is a plain button, so it never submits a surrounding form", () => {
    renderToggles();

    expect(screen.getByRole("button", { name: "Bug" })).toHaveAttribute(
      "type",
      "button",
    );
  });
});
