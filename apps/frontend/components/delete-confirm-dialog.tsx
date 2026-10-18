"use client";

import type { ReactNode } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";

type DeleteConfirmDialogProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The dialog title, e.g. `"Delete Skill"`. */
  readonly title: string;
  readonly description: ReactNode;
  /** Defaults to "Delete"; override only to name what is deleted. */
  readonly confirmLabel?: string;
  /** When set, the confirm button stays disabled until the phrase is typed. */
  readonly confirmPhrase?: string;
  /** Keeps the confirm button disabled while the delete is not allowed. */
  readonly confirmDisabled?: boolean;
  /** Defaults to "Cancel". */
  readonly cancelLabel?: string;
  readonly onConfirm: () => void;
  readonly loading?: boolean;
  /** A failed delete's message, shown in the dialog rather than a toast. */
  readonly error?: string | null;
};

/**
 * The destructive confirm dialog shared by every list's and entity form's
 * delete flow (#877): `ConfirmDialog` with the delete variant, label default,
 * and loading copy fixed so a delete never drifts between callers.
 */
export function DeleteConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  confirmPhrase,
  confirmDisabled,
  cancelLabel,
  onConfirm,
  loading = false,
  error = null,
}: DeleteConfirmDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      confirmVariant="destructive"
      confirmPhrase={confirmPhrase}
      confirmDisabled={confirmDisabled}
      cancelLabel={cancelLabel}
      loadingLabel="Deleting..."
      onConfirm={onConfirm}
      loading={loading}
      error={error}
    />
  );
}
