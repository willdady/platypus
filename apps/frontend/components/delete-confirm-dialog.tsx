"use client";

import type { ReactNode } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";

type DeleteConfirmDialogProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly noun: string;
  readonly name?: string;
  readonly consequence?: ReactNode;
  readonly blockedReason?: string;
  readonly confirmLabel?: string;
  readonly requireTypedConfirmation?: boolean;
  readonly confirmDisabled?: boolean;
  readonly cancelLabel?: string;
  readonly onConfirm: () => void;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onCloseAutoFocus?: (event: Event) => void;
};

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
