"use client";

import type { ReactNode } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";

type DeleteConfirmDialogProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** What is deleted, as it reads after "Delete": `"agent"`, `"MCP server"`. */
  readonly noun: string;
  /** The entity's name, quoted in the question. Omit for a delete from a form. */
  readonly name?: string;
  /** Extra sentence(s) between the question and the undo warning. */
  readonly consequence?: ReactNode;
  /**
   * Why the delete is refused. Replaces the question and undo warning, and
   * keeps the confirm button disabled.
   */
  readonly blockedReason?: string;
  /** Defaults to "Delete"; override only to name what is deleted. */
  readonly confirmLabel?: string;
  /**
   * When set, the confirm button stays disabled until the user types the
   * dialog title. Keeps the phrase and the title from drifting apart.
   */
  readonly requireTypedConfirmation?: boolean;
  /** Keeps the confirm button disabled while the delete is not allowed. */
  readonly confirmDisabled?: boolean;
  /** Defaults to "Cancel". */
  readonly cancelLabel?: string;
  readonly onConfirm: () => void;
  readonly loading?: boolean;
  /** A failed delete's message, shown in the dialog rather than a toast. */
  readonly error?: string | null;
  /** Where focus lands when the dialog closes. */
  readonly onCloseAutoFocus?: (event: Event) => void;
};

/**
 * The destructive confirm dialog shared by every list's and entity form's
 * delete flow (#877): `ConfirmDialog` with the delete variant, label default,
 * loading copy fixed, and the title, question and undo warning composed from
 * the noun so a delete never drifts between callers.
 */
export function DeleteConfirmDialog({
  open,
  onOpenChange,
  noun,
  name,
  consequence,
  blockedReason,
  confirmLabel = "Delete",
  requireTypedConfirmation = false,
  confirmDisabled,
  cancelLabel,
  onConfirm,
  loading = false,
  error = null,
  onCloseAutoFocus,
}: DeleteConfirmDialogProps) {
  const title = `Delete ${noun}`;
  const question = name
    ? `Are you sure you want to delete "${name}"?`
    : `Are you sure you want to delete this ${noun}?`;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={
        blockedReason ? (
          blockedReason
        ) : (
          <>
            {question}
            {consequence ? <> {consequence}</> : null} This action cannot be
            undone.
          </>
        )
      }
      confirmLabel={confirmLabel}
      confirmVariant="destructive"
      confirmPhrase={
        requireTypedConfirmation && !blockedReason ? title : undefined
      }
      confirmDisabled={blockedReason ? true : confirmDisabled}
      cancelLabel={cancelLabel}
      loadingLabel="Deleting..."
      onConfirm={onConfirm}
      loading={loading}
      error={error}
      onCloseAutoFocus={onCloseAutoFocus}
    />
  );
}
