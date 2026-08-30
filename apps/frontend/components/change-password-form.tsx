"use client";

import { useState } from "react";
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
import { toast } from "sonner";

export function ChangePasswordForm() {
  const { authClient } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrors({});

    if (newPassword !== confirmPassword) {
      setErrors({ confirmPassword: "Passwords do not match" });
      setIsSubmitting(false);
      return;
    }

    const { error } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });

    if (error) {
      toast.error(error.message || "Failed to change password");
      setIsSubmitting(false);
    } else {
      toast.success("Password changed successfully");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <FieldSet className="mb-8">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="currentPassword">Current Password</FieldLabel>
            <RevealableInput
              id="currentPassword"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              disabled={isSubmitting}
              revealLabel="current password"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="newPassword">New Password</FieldLabel>
            <RevealableInput
              id="newPassword"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              disabled={isSubmitting}
              revealLabel="new password"
            />
          </Field>
          <Field data-invalid={!!errors.confirmPassword}>
            <FieldLabel htmlFor="confirmPassword">
              Confirm New Password
            </FieldLabel>
            <RevealableInput
              id="confirmPassword"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              disabled={isSubmitting}
              aria-invalid={!!errors.confirmPassword}
              revealLabel="confirm new password"
            />
            {errors.confirmPassword && (
              <FieldError>{errors.confirmPassword}</FieldError>
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
