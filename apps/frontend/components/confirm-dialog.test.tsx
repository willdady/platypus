import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "./confirm-dialog";

describe("ConfirmDialog", () => {
  it("enables confirm immediately when no confirmPhrase is set", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Delete thing"
        description="Are you sure?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("disables confirm until the typed phrase matches, case-insensitively", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Delete workspace"
        description="Are you sure?"
        confirmLabel="Delete"
        confirmVariant="destructive"
        confirmPhrase="Delete workspace"
        onConfirm={onConfirm}
      />,
    );

    const confirmButton = screen.getByRole("button", { name: "Delete" });
    const input = screen.getByPlaceholderText(
      "Type 'Delete workspace' to confirm",
    );

    expect(confirmButton).toBeDisabled();

    fireEvent.change(input, { target: { value: "wrong phrase" } });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(input, { target: { value: "delete workspace" } });
    expect(confirmButton).toBeEnabled();

    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("resets the typed phrase when the dialog reopens", () => {
    const { rerender } = render(
      <ConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Delete workspace"
        description="Are you sure?"
        confirmPhrase="Delete workspace"
        onConfirm={vi.fn()}
      />,
    );

    const input = screen.getByPlaceholderText(
      "Type 'Delete workspace' to confirm",
    );
    fireEvent.change(input, { target: { value: "delete workspace" } });
    expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();

    rerender(
      <ConfirmDialog
        open={false}
        onOpenChange={vi.fn()}
        title="Delete workspace"
        description="Are you sure?"
        confirmPhrase="Delete workspace"
        onConfirm={vi.fn()}
      />,
    );
    rerender(
      <ConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Delete workspace"
        description="Are you sure?"
        confirmPhrase="Delete workspace"
        onConfirm={vi.fn()}
      />,
    );

    const reopenedInput = screen.getByPlaceholderText(
      "Type 'Delete workspace' to confirm",
    );
    expect(reopenedInput).toHaveValue("");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("keeps the dialog non-dismissible while loading, regardless of confirmPhrase", () => {
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Delete workspace"
        description="Are you sure?"
        confirmPhrase="Delete workspace"
        onConfirm={vi.fn()}
        loading={true}
      />,
    );

    const input = screen.getByPlaceholderText(
      "Type 'Delete workspace' to confirm",
    );
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
