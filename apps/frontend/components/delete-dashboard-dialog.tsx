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

interface DeleteDashboardDialogProps {
  dashboardName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void | Promise<void>;
  loading?: boolean;
  error?: string | null;
}

export function DeleteDashboardDialog({
  dashboardName,
  open,
  onOpenChange,
  onConfirm,
  loading = false,
  error = null,
}: DeleteDashboardDialogProps) {
  const [confirmationText, setConfirmationText] = useState("");

  const isConfirmed = confirmationText.toLowerCase() === "delete dashboard";

  const handleOpenChange = (open: boolean) => {
    if (loading) return;
    if (!open) setConfirmationText("");
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
          <DialogTitle>Delete Dashboard</DialogTitle>
          <DialogDescription>
            This action cannot be undone. This will permanently delete the
            dashboard <span className="font-semibold">{dashboardName}</span> and
            all of its widgets.
          </DialogDescription>
          <div className="mt-4">
            <Input
              placeholder="Type 'Delete dashboard' to confirm"
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
