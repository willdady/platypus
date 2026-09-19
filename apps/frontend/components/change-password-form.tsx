"use client";

import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { RevealableInput } from "@/components/ui/revealable-input";
import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldError,
} from "@/components/ui/field";
import { useEntityForm } from "@/hooks/use-entity-form";

const RETRACTABLE_FIELDS = [
  "currentPassword",
  "newPassword",
  "confirmPassword",
] as const;

const INITIAL_DATA = {
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
};

export function ChangePasswordForm() {
  const { authClient } = useAuth();

  const {
    formData,
    setFormData,
    validationErrors,
    setValidationErrors,
    isSubmitting,
    handleChange,
    submit,
  } = useEntityForm<typeof INITIAL_DATA, unknown>({
    initialData: INITIAL_DATA,
    entity: "password",
    scope: {},
    retractableFields: RETRACTABLE_FIELDS,
    // The password change is an auth-client call, not a REST write — kept
    // local, mapped onto the shared outcome shape.
    write: async (data) => {
      const { error } = await authClient.changePassword({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
        revokeOtherSessions: true,
      });
      return error
        ? {
            outcome: "error",
            message: error.message || "Failed to change password",
          }
        : { outcome: "success", data: {}, revalidateKeys: [] };
    },
    successMessage: "Password changed successfully",
    onSuccess: () => {
      setFormData(INITIAL_DATA);
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (formData.newPassword !== formData.confirmPassword) {
      setValidationErrors({ confirmPassword: "Passwords do not match" });
      return;
    }

    await submit();
  };

  return (
    <form onSubmit={handleSubmit}>
      <FieldSet className="mb-8">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="currentPassword">Current Password</FieldLabel>
            <RevealableInput
              id="currentPassword"
              value={formData.currentPassword}
              onChange={handleChange}
              required
              disabled={isSubmitting}
              revealLabel="current password"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="newPassword">New Password</FieldLabel>
            <RevealableInput
              id="newPassword"
              value={formData.newPassword}
              onChange={handleChange}
              required
              disabled={isSubmitting}
              revealLabel="new password"
            />
          </Field>
          <Field data-invalid={!!validationErrors.confirmPassword}>
            <FieldLabel htmlFor="confirmPassword">
              Confirm New Password
            </FieldLabel>
            <RevealableInput
              id="confirmPassword"
              value={formData.confirmPassword}
              onChange={handleChange}
              required
              disabled={isSubmitting}
              aria-invalid={!!validationErrors.confirmPassword}
              revealLabel="confirm new password"
            />
            {validationErrors.confirmPassword && (
              <FieldError>{validationErrors.confirmPassword}</FieldError>
            )}
          </Field>
        </FieldGroup>
      </FieldSet>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Changing..." : "Change password"}
      </Button>
    </form>
  );
}
