import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { KanbanLabelToggles } from "./kanban-label-toggles";

const labels = [
  { id: "l1", name: "Bug", color: "#ff0000" },
  { id: "l2", name: "Feature", color: "#0000ff" },
] as Parameters<typeof KanbanLabelToggles>[0]["labels"];

function renderToggles(selectedIds: string[], onToggle = vi.fn()) {
  render(
    <>
      <p id="labels-heading">Labels</p>
      <KanbanLabelToggles
        labels={labels}
        selectedIds={selectedIds}
        onToggle={onToggle}
        labelledBy="labels-heading"
      />
    </>,
  );
  return { onToggle };
}

describe("KanbanLabelToggles", () => {
  it("exposes each label as a toggle inside a named group", () => {
    renderToggles(["l1"]);

    expect(screen.getByRole("group", { name: "Labels" })).toBeInTheDocument();

    const bug = screen.getByRole("button", { name: "Bug" });
    const feature = screen.getByRole("button", { name: "Feature" });
    expect(bug).toHaveAttribute("type", "button");
    expect(bug).toHaveAttribute("aria-pressed", "true");
    expect(feature).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the label colours and dims only the unselected labels", () => {
    renderToggles(["l1"]);

    const bug = screen.getByRole("button", { name: "Bug" });
    const feature = screen.getByRole("button", { name: "Feature" });
    expect(bug).toHaveStyle({ backgroundColor: "rgb(255, 0, 0)" });
    expect(feature).toHaveStyle({ backgroundColor: "rgb(0, 0, 255)" });
    expect(bug).not.toHaveClass("opacity-40");
    expect(feature).toHaveClass("opacity-40");
  });

  it("toggles a label with Space and with Enter after reaching it with Tab", async () => {
    const user = userEvent.setup();
    const { onToggle } = renderToggles(["l1"]);

    await user.tab();
    const feature = screen.getByRole("button", { name: "Feature" });
    await user.tab();
    expect(feature).toHaveFocus();

    await user.keyboard(" ");
    await user.keyboard("{Enter}");

    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onToggle).toHaveBeenNthCalledWith(1, "l2");
    expect(onToggle).toHaveBeenNthCalledWith(2, "l2");
  });

  it("does not submit the surrounding form", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <p id="labels-heading">Labels</p>
        <KanbanLabelToggles
          labels={labels}
          selectedIds={[]}
          onToggle={vi.fn()}
          labelledBy="labels-heading"
        />
      </form>,
    );

    const bug = screen.getByRole("button", { name: "Bug" });
    await user.click(bug);
    await user.keyboard("{Enter}");

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
