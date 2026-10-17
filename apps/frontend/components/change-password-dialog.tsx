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
import { RevealableInput } from "@/components/ui/revealable-input";
import {
  Field,
  FieldError,
  FieldLabel,
  FieldGroup,
  FieldSet,
} from "@/components/ui/field";
import { useAuth, type User } from "@/components/auth-provider";
import { useEntityForm } from "@/hooks/use-entity-form";

const RETRACTABLE_FIELDS = ["newPassword"] as const;
const INITIAL_DATA = { newPassword: "" };

interface ChangePasswordDialogProps {
  user: Pick<User, "id" | "email" | "name">;
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
  const { authClient } = useAuth();

  const {
    formData,
    setFormData,
    validationErrors,
    setValidationErrors,
    isSubmitting,
    handleChange,
    submit,
  } = useEntityForm<typeof INITIAL_DATA>({
    initialData: INITIAL_DATA,
    entity: "admin/set-user-password",
    scope: {},
    retractableFields: RETRACTABLE_FIELDS,
    // An admin auth-client call, not a REST write — mapped onto the shared
    // outcome shape. The server owns the length rule; its 400 lands on the
    // field.
    write: async ({ newPassword }) => {
      const { error } = await authClient.admin.setUserPassword({
        userId: user.id,
        newPassword,
      });
      if (!error) return { outcome: "success", data: {}, revalidateKeys: [] };
      const message = error.message || "Failed to update password";
      return error.status === 400
        ? { outcome: "invalid", message, fieldErrors: { newPassword: message } }
        : { outcome: "error", message };
    },
    successMessage: () => `Password updated successfully for ${user.name}`,
    onSuccess: () => {
      setFormData(INITIAL_DATA);
      onSuccess();
    },
  });
  const newPassword = formData.newPassword;
  const validationError = validationErrors.newPassword;

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setFormData(INITIAL_DATA);
      setValidationErrors({});
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
            <Field data-invalid={!!validationError}>
              <FieldLabel htmlFor="newPassword">New Password</FieldLabel>
              <RevealableInput
                id="newPassword"
                value={newPassword}
                onChange={handleChange}
                disabled={isSubmitting}
                aria-invalid={!!validationError}
                placeholder="Enter new password"
                autoComplete="new-password"
                revealLabel="new password"
              />
              {validationError && <FieldError>{validationError}</FieldError>}
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
            onClick={() => submit()}
            disabled={isSubmitting || !newPassword}
            className={isSubmitting ? "opacity-50" : ""}
          >
            {isSubmitting ? "Updating..." : "Update password"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
