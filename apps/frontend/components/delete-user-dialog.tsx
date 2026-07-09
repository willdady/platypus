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
import { useBackendUrl } from "@/app/client-context";
import { joinUrl } from "@/lib/utils";
import { toast } from "sonner";

interface User {
  id: string;
  email: string;
  name: string;
}

interface DeleteUserDialogProps {
  user: User;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function DeleteUserDialog({
  user,
  open,
  onOpenChange,
  onSuccess,
}: DeleteUserDialogProps) {
  const backendUrl = useBackendUrl();
  const [confirmationText, setConfirmationText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const response = await fetch(
        joinUrl(backendUrl, "/auth/admin/remove-user"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: window.location.origin,
          },
          body: JSON.stringify({
            userId: user.id,
          }),
          credentials: "include",
        },
      );

      if (response.ok) {
        toast.success(`User ${user.name} has been deleted`);
        setConfirmationText("");
        onSuccess();
      } else {
        const data = await response.json();
        toast.error(data.error || data.message || "Failed to delete user");
      }
    } catch (error) {
      toast.error("Error deleting user");
      console.error(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setConfirmationText("");
    }
    onOpenChange(open);
  };

  const isConfirmed = confirmationText.toLowerCase() === "delete user";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete User</DialogTitle>
          <DialogDescription>
            This action cannot be undone. This will permanently delete the user{" "}
            <span className="font-semibold">{user.name}</span> ({user.email})
            and remove all of their data from the system.
          </DialogDescription>
          <div className="mt-4">
            <Input
              placeholder="Type 'Delete user' to confirm"
              value={confirmationText}
              onChange={(e) => setConfirmationText(e.target.value)}
              disabled={isSubmitting}
              autoComplete="off"
            />
          </div>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={isSubmitting || !isConfirmed}
            className={isSubmitting ? "opacity-50" : ""}
          >
            {isSubmitting ? "Deleting..." : "Delete user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
