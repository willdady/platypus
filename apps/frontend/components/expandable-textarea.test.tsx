import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ExpandableTextarea } from "./expandable-textarea";

function Harness({ onChange }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("Hello");
  return (
    <ExpandableTextarea
      id="instructions"
      label="Instructions"
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        onChange?.(e.target.value);
      }}
    />
  );
}

const expand = () =>
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));

describe("ExpandableTextarea expanded editor", () => {
  it("opens as a modal dialog named after the field", async () => {
    render(<Harness />);
    expand();

    const dialog = await screen.findByRole("dialog", { name: "Instructions" });
    expect(dialog).toBeInTheDocument();
  });

  it("moves focus into the editor, and back to Expand on close", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Expand" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Expand" })).toHaveFocus();
  });

  it("commits the draft when closed", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    expand();

    const dialog = await screen.findByRole("dialog");
    const editor = dialog.querySelector("textarea")!;
    fireEvent.change(editor, { target: { value: "Hello world" } });
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onChange).toHaveBeenCalledWith("Hello world");
    expect(screen.getByLabelText("Instructions")).toHaveValue("Hello world");
  });

  it("offers Write and Preview as tabs that report which is selected", async () => {
    render(<Harness />);
    expand();
    await screen.findByRole("dialog");

    const write = screen.getByRole("tab", { name: "Write" });
    const preview = screen.getByRole("tab", { name: "Preview" });
    expect(write).toHaveAttribute("aria-selected", "true");
    expect(preview).toHaveAttribute("aria-selected", "false");

    fireEvent.mouseDown(preview, { button: 0 });

    await waitFor(() =>
      expect(preview).toHaveAttribute("aria-selected", "true"),
    );
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Hello");
  });
});
