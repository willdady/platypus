"use client";

import { useAuthClient } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { FieldGroup, FieldSet } from "@/components/ui/field";
import { FormTextField } from "@/components/form-text-field";
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
  const authClient = useAuthClient();

  const {
    formData,
    seedFormData,
    validationErrors,
    setValidationErrors,
    isSubmitting,
    toFieldChange,
    submit,
  } = useEntityForm<typeof INITIAL_DATA, unknown>({
    initialData: INITIAL_DATA,
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
      seedFormData(INITIAL_DATA);
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
          <FormTextField
            label="Current Password"
            name="currentPassword"
            value={formData.currentPassword}
            onChange={toFieldChange("currentPassword")}
            required
            disabled={isSubmitting}
            error={validationErrors.currentPassword}
            revealable
            revealLabel="current password"
          />
          <FormTextField
            label="New Password"
            name="newPassword"
            value={formData.newPassword}
            onChange={toFieldChange("newPassword")}
            required
            disabled={isSubmitting}
            error={validationErrors.newPassword}
            revealable
            revealLabel="new password"
          />
          <FormTextField
            label="Confirm New Password"
            name="confirmPassword"
            value={formData.confirmPassword}
            onChange={toFieldChange("confirmPassword")}
            required
            disabled={isSubmitting}
            error={validationErrors.confirmPassword}
            revealable
            revealLabel="confirm new password"
          />
        </FieldGroup>
      </FieldSet>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Changing..." : "Change password"}
      </Button>
    </form>
  );
}
