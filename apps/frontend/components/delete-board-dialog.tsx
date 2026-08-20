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

interface DeleteBoardDialogProps {
  boardName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
  error?: string | null;
}

export function DeleteBoardDialog({
  boardName,
  open,
  onOpenChange,
  onConfirm,
  loading = false,
  error = null,
}: DeleteBoardDialogProps) {
  const [confirmationText, setConfirmationText] = useState("");

  const isConfirmed = confirmationText.toLowerCase() === "delete board";

  const handleOpenChange = (open: boolean) => {
    if (loading) return;
    if (!open) {
      setConfirmationText("");
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        onPointerDownOutside={(e) => {
          if (loading) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (loading) e.preventDefault();
        }}
        showCloseButton={!loading}
      >
        <DialogHeader>
          <DialogTitle>Delete Board</DialogTitle>
          <DialogDescription>
            This action cannot be undone. This will permanently delete the board{" "}
            <span className="font-semibold">{boardName}</span> and all of its
            data.
          </DialogDescription>
          <div className="mt-4">
            <Input
              placeholder="Type 'Delete board' to confirm"
              value={confirmationText}
              onChange={(e) => setConfirmationText(e.target.value)}
              disabled={loading}
              autoComplete="off"
            />
          </div>
        </DialogHeader>
        {error && (
          <div className="py-2 px-4 bg-destructive/10 text-destructive text-sm rounded">
            {error}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={loading || !isConfirmed}
          >
            {loading ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
