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
import { Field, FieldLabel, FieldGroup, FieldSet } from "@/components/ui/field";
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

  const isConfirmed = confirmationText === "delete";

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
        </DialogHeader>

        <FieldSet>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="confirmation">
                Type <span className="font-mono font-semibold">delete</span> to
                confirm
              </FieldLabel>
              <Input
                id="confirmation"
                type="text"
                value={confirmationText}
                onChange={(e) => setConfirmationText(e.target.value)}
                disabled={isSubmitting}
                placeholder="delete"
                autoComplete="off"
              />
            </Field>
          </FieldGroup>
        </FieldSet>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isSubmitting}
            className="cursor-pointer"
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={isSubmitting || !isConfirmed}
            className={`cursor-pointer ${isSubmitting ? "opacity-50" : ""}`}
          >
            {isSubmitting ? "Deleting..." : "Delete User"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
