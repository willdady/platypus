"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  confirmVariant?: "default" | "destructive" | "outline" | "ghost";
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel?: () => void;
  loading?: boolean;
  error?: string | null;
  // When set, the confirm button stays disabled until the user types this
  // phrase (case-insensitively) into an input rendered in the dialog.
  confirmPhrase?: string;
}

export const ConfirmDialog = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  confirmVariant = "default",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  loading = false,
  error = null,
  confirmPhrase,
}: ConfirmDialogProps) => {
  const [typedPhrase, setTypedPhrase] = useState("");

  useResetOnChange(open, () => {
    if (open) {
      setTypedPhrase("");
    }
  });

  const phraseMatches =
    !confirmPhrase || typedPhrase.toLowerCase() === confirmPhrase.toLowerCase();

  const handleCancel = () => {
    if (onCancel) {
      onCancel();
    }
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!loading) {
          onOpenChange(open);
        }
      }}
    >
      <DialogContent
        onPointerDownOutside={(e) => {
          if (loading) {
            e.preventDefault();
          }
        }}
        onEscapeKeyDown={(e) => {
          if (loading) {
            e.preventDefault();
          }
        }}
        showCloseButton={!loading}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
          {confirmPhrase && (
            <div className="mt-4">
              <Input
                placeholder={`Type '${confirmPhrase}' to confirm`}
                value={typedPhrase}
                onChange={(e) => setTypedPhrase(e.target.value)}
                disabled={loading}
              />
            </div>
          )}
        </DialogHeader>
        {error && (
          <div className="py-2 px-4 bg-destructive/10 text-destructive text-sm rounded">
            {error}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={handleCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            onClick={onConfirm}
            disabled={loading || !phraseMatches}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
