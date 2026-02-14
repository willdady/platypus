"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldError,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { fetcher, parseValidationErrors, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { toast } from "sonner";

interface InvitationFormProps {
  orgId: string;
  onSuccess?: () => void;
}

export function InvitationForm({ orgId, onSuccess }: InvitationFormProps) {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setValidationErrors({});

    try {
      const response = await fetch(
        joinUrl(backendUrl, `/organizations/${orgId}/invitations`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
          credentials: "include",
        },
      );

      if (response.ok) {
        toast.success("Invitation created");
        setEmail("");
        onSuccess?.();
      } else {
        const errorData = await response.json();
        const errors = parseValidationErrors(errorData);
        setValidationErrors(errors);

        if (errorData.message) {
          toast.error(errorData.message);
        } else if (Object.keys(errors).length > 0) {
          toast.error("Please fix the errors in the form");
        } else {
          toast.error("Failed to send invitation");
        }
      }
    } catch (error) {
      toast.error("Error sending invitation");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 border p-4 rounded-lg bg-muted/30"
    >
      <h3 className="font-semibold">Invite User to Organization</h3>
      <FieldSet>
        <FieldGroup className="gap-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field data-invalid={!!validationErrors.email}>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                type="email"
                placeholder="user@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (validationErrors.email) {
                    setValidationErrors((prev) => {
                      const next = { ...prev };
                      delete next.email;
                      return next;
                    });
                  }
                }}
                disabled={isSubmitting}
                autoFocus
                required
              />
              {validationErrors.email && (
                <FieldError>{validationErrors.email}</FieldError>
              )}
            </Field>
          </div>
        </FieldGroup>
      </FieldSet>
      <Button
        type="submit"
        disabled={isSubmitting}
        className={`w-full md:w-auto mt-2 ${!isSubmitting ? "cursor-pointer" : ""}`}
      >
        {isSubmitting ? "Sending..." : "Send Invitation"}
      </Button>
    </form>
  );
}
