"use client";

import type { ReactNode } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";

interface DeleteConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: ReactNode;
  /** Defaults to "Delete"; the entity form is the caller's copy. */
  readonly confirmLabel?: string;
  /** When set, the confirm button stays disabled until the phrase is typed. */
  readonly confirmPhrase?: string;
  readonly onConfirm: () => void;
  readonly loading?: boolean;
  readonly error?: string | null;
}

/**
 * The destructive confirm dialog shared by every list's delete flow (#877):
 * `ConfirmDialog` with the delete variant, label, and loading copy fixed so
 * lists declare only their title and description.
 */
export function DeleteConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  confirmPhrase,
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
      loadingLabel="Deleting..."
      onConfirm={onConfirm}
      loading={loading}
      error={error}
    />
  );
}
