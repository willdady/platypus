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

interface ChangePasswordDialogProps {
  user: User;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function ChangePasswordDialog({
  user,
  open,
  onOpenChange,
  onSuccess,
}: ChangePasswordDialogProps) {
  const backendUrl = useBackendUrl();
  const [newPassword, setNewPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = async () => {
    // Client-side validation
    setValidationError(null);

    if (!newPassword) {
      setValidationError("Password is required");
      return;
    }

    if (newPassword.length < 8) {
      setValidationError("Password must be at least 8 characters");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch(
        joinUrl(backendUrl, "/auth/admin/set-user-password"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: window.location.origin,
          },
          body: JSON.stringify({
            userId: user.id,
            newPassword,
          }),
          credentials: "include",
        },
      );

      if (response.ok) {
        toast.success(`Password updated successfully for ${user.name}`);
        setNewPassword("");
        onSuccess();
      } else {
        const data = await response.json();
        toast.error(data.error || data.message || "Failed to update password");
      }
    } catch (error) {
      toast.error("Error updating password");
      console.error(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setNewPassword("");
      setValidationError(null);
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change Password</DialogTitle>
          <DialogDescription>
            Set a new password for {user.name} ({user.email}).
          </DialogDescription>
        </DialogHeader>

        <FieldSet>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="newPassword">New Password</FieldLabel>
              <Input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  setValidationError(null);
                }}
                disabled={isSubmitting}
                placeholder="Enter new password (min 8 characters)"
                autoComplete="new-password"
              />
              {validationError && (
                <p className="text-sm text-destructive mt-1">
                  {validationError}
                </p>
              )}
            </Field>
          </FieldGroup>
        </FieldSet>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || !newPassword}
            className={isSubmitting ? "opacity-50" : ""}
          >
            {isSubmitting ? "Updating..." : "Update Password"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
