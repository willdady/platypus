import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";

function renderDialog({
  noun = "agent",
  name,
  consequence,
  blockedReason,
  requireTypedConfirmation = false,
}: {
  noun?: string;
  name?: string;
  consequence?: string;
  blockedReason?: string;
  requireTypedConfirmation?: boolean;
} = {}) {
  render(
    <DeleteConfirmDialog
      open
      onOpenChange={vi.fn()}
      noun={noun}
      name={name}
      consequence={consequence}
      blockedReason={blockedReason}
      requireTypedConfirmation={requireTypedConfirmation}
      onConfirm={vi.fn()}
    />,
  );
}

describe("DeleteConfirmDialog", () => {
  it("titles the dialog from the noun", () => {
    renderDialog();

    expect(screen.getByRole("dialog", { name: "Delete agent" })).toBeVisible();
  });

  // An acronym in the noun keeps its case, so it never reads "Mcp".
  it("keeps an acronym in the noun as written", () => {
    renderDialog({ noun: "MCP server" });

    expect(
      screen.getByRole("dialog", { name: "Delete MCP server" }),
    ).toBeVisible();
  });

  it("asks about this noun when no name is given", () => {
    renderDialog();

    expect(
      screen.getByText(
        "Are you sure you want to delete this agent? This action cannot be undone.",
      ),
    ).toBeInTheDocument();
  });

  it("quotes the name when one is given", () => {
    renderDialog({ name: "Scout" });

    expect(
      screen.getByText(
        'Are you sure you want to delete "Scout"? This action cannot be undone.',
      ),
    ).toBeInTheDocument();
  });

  it("puts the consequence between the question and the undo warning", () => {
    renderDialog({
      name: "Scout",
      consequence: "This also deletes its run history.",
    });

    expect(
      screen.getByText(
        'Are you sure you want to delete "Scout"? This also deletes its run history. This action cannot be undone.',
      ),
    ).toBeInTheDocument();
  });

  it("asks for a typed phrase equal to the title", () => {
    renderDialog({ noun: "workspace", requireTypedConfirmation: true });

    const input = screen.getByPlaceholderText(
      "Type 'Delete workspace' to confirm",
    );
    const confirmButton = screen.getByRole("button", { name: "Delete" });

    expect(confirmButton).toBeDisabled();

    fireEvent.change(input, { target: { value: "Delete workspace" } });

    expect(confirmButton).toBeEnabled();
  });

  it("explains a blocked delete in place of the question and undo warning", () => {
    renderDialog({
      noun: "column",
      blockedReason:
        "Cannot delete this column because it contains cards. Move or delete all cards first.",
    });

    expect(
      screen.getByText(
        "Cannot delete this column because it contains cards. Move or delete all cards first.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/This action cannot be undone/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });
});
