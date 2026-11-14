import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
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

function expand() {
  return fireEvent.click(screen.getByRole("button", { name: "Expand" }));
}

function FieldHarness({
  description,
  error,
}: {
  description?: string;
  error?: string;
}) {
  return (
    <ExpandableTextarea
      id="notes"
      label="Notes"
      value=""
      onChange={vi.fn()}
      expandable={false}
      description={description}
      error={error}
    />
  );
}

describe("ExpandableTextarea field", () => {
  it("marks the textarea invalid when it has an error", () => {
    render(<FieldHarness error="Notes are required" />);

    expect(screen.getByLabelText("Notes")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("leaves the textarea valid when it has no error", () => {
    render(<FieldHarness />);

    expect(screen.getByLabelText("Notes")).toHaveAttribute(
      "aria-invalid",
      "false",
    );
  });

  it("renders the error after the description", () => {
    render(
      <FieldHarness
        description="What these notes are for."
        error="Notes are required"
      />,
    );

    const description = screen.getByText("What these notes are for.");
    const error = screen.getByRole("alert");
    expect(
      description.compareDocumentPosition(error) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

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
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Expand" })).toHaveFocus();
  });

  it("marks the expanded editor invalid, and describes it with the error", async () => {
    render(
      <ExpandableTextarea
        id="notes"
        label="Notes"
        value=""
        onChange={vi.fn()}
        error="Notes are required"
      />,
    );
    expand();

    const dialog = await screen.findByRole("dialog");
    const editor = within(dialog).getByRole("textbox");
    expect(editor).toHaveAttribute("aria-invalid", "true");
    expect(editor).toHaveAccessibleDescription("Notes are required");
  });

  it("commits the draft when closed", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    expand();

    const dialog = await screen.findByRole("dialog");
    const editor = dialog.querySelector("textarea")!;
    fireEvent.change(editor, { target: { value: "Hello world" } });
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
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
