"use client";

import { ConfirmDialog } from "@/components/confirm-dialog";
import type { ReactNode } from "react";

export type EntityDeleteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The dialog title, e.g. `"Delete Skill"`. */
  title: string;
  description: ReactNode;
  onConfirm: () => void;
  loading?: boolean;
  /** A failed delete's message, shown in the dialog rather than a toast. */
  error?: string | null;
  /** When set, the confirm button needs this phrase typed first. */
  confirmPhrase?: string;
};

/**
 * The destructive confirm dialog every entity form opened by hand. Fixes the
 * confirm copy and the destructive variant in one place, so a delete never
 * drifts between forms.
 */
export const EntityDeleteDialog = ({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  loading,
  error,
  confirmPhrase,
}: EntityDeleteDialogProps) => (
  <ConfirmDialog
    open={open}
    onOpenChange={onOpenChange}
    title={title}
    description={description}
    confirmLabel="Delete"
    confirmVariant="destructive"
    loadingLabel="Deleting..."
    onConfirm={onConfirm}
    loading={loading}
    error={error}
    confirmPhrase={confirmPhrase}
  />
);
