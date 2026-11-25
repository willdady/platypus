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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { useState, type ReactNode } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";

type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  loadingLabel?: string;
  confirmVariant?: "default" | "destructive" | "outline" | "ghost";
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel?: () => void;
  loading?: boolean;
  error?: string | null;
  confirmPhrase?: string;
  confirmDisabled?: boolean;
  // why: a dialog with no trigger drops focus to the body when it closes
  onCloseAutoFocus?: (event: Event) => void;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  loadingLabel,
  confirmVariant = "default",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  loading = false,
  error = null,
  confirmPhrase,
  confirmDisabled = false,
  onCloseAutoFocus,
}: ConfirmDialogProps) {
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
        onCloseAutoFocus={onCloseAutoFocus}
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
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            onClick={onConfirm}
            disabled={loading || !phraseMatches || confirmDisabled}
          >
            {loading && loadingLabel ? loadingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
