import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { KanbanLabel } from "@platypus/schemas";
import { AddCardDialog } from "./kanban-board-dialogs";

const labels: KanbanLabel[] = [
  { id: "l1", name: "Bug", color: "#ef4444" },
  { id: "l2", name: "UI", color: "#3b82f6" },
];

function renderAddCardDialog(onSubmit = vi.fn().mockResolvedValue(undefined)) {
  render(
    <AddCardDialog labels={labels} onSubmit={onSubmit} onClose={() => {}} />,
  );
  return onSubmit;
}

describe("AddCardDialog labels", () => {
  it("groups the toggles under an accessible name", () => {
    renderAddCardDialog();

    expect(screen.getByRole("group", { name: "Labels" })).toBeInTheDocument();
  });

  it("reaches a label with Tab and toggles it on with Enter without submitting the form", async () => {
    const onSubmit = renderAddCardDialog();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Card Title"), "New card");
    const toggle = screen.getByRole("button", { name: "Bug" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Add card" }));

    expect(onSubmit).toHaveBeenCalledWith({
      title: "New card",
      labelIds: ["l1"],
    });
  });
});
