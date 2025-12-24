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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState } from "react";
import { type Workspace } from "@platypus/schemas";
import { fetcher, parseValidationErrors, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { toast } from "sonner";
import useSWR from "swr";

interface InvitationFormProps {
  orgId: string;
  onSuccess?: () => void;
}

export function InvitationForm({ orgId, onSuccess }: InvitationFormProps) {
  const backendUrl = useBackendUrl();
  const { data: workspacesData } = useSWR<{ results: Workspace[] }>(
    joinUrl(backendUrl, `/organisations/${orgId}/workspaces`),
    fetcher
  );

  const [formData, setFormData] = useState({
    email: "",
    workspaceId: "",
    role: "viewer",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { id, value } = e.target;
    setFormData((prev) => ({ ...prev, [id]: value }));
    if (validationErrors[id]) {
      setValidationErrors((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const handleSelectChange = (id: string, value: string) => {
    setFormData((prev) => ({ ...prev, [id]: value }));
    if (validationErrors[id]) {
      setValidationErrors((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setValidationErrors({});

    try {
      const response = await fetch(
        joinUrl(backendUrl, `/organisations/${orgId}/invitations`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
          credentials: "include",
        }
      );

      if (response.ok) {
        toast.success("Invitation sent");
        setFormData({ email: "", workspaceId: "", role: "viewer" });
        onSuccess?.();
      } else {
        const errorData = await response.json();
        const errors = parseValidationErrors(errorData);
        setValidationErrors(errors);

        // If there's a top-level message (like duplicate invite), show it in toast
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
    <form onSubmit={handleSubmit} className="space-y-4 border p-4 rounded-lg bg-muted/30">
      <h3 className="font-semibold">Invite User</h3>
      <FieldSet>
        <FieldGroup className="gap-y-4">
          <Field data-invalid={!!validationErrors.email}>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              type="email"
              placeholder="user@example.com"
              value={formData.email}
              onChange={handleChange}
              disabled={isSubmitting}
              required
            />
            {validationErrors.email && <FieldError>{validationErrors.email}</FieldError>}
          </Field>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field data-invalid={!!validationErrors.workspaceId}>
              <FieldLabel htmlFor="workspaceId">Workspace</FieldLabel>
              <Select
                value={formData.workspaceId}
                onValueChange={(v) => handleSelectChange("workspaceId", v)}
                disabled={isSubmitting}
              >
                <SelectTrigger id="workspaceId">
                  <SelectValue placeholder="Select workspace" />
                </SelectTrigger>
                <SelectContent>
                  {workspacesData?.results.map((ws) => (
                    <SelectItem key={ws.id} value={ws.id}>
                      {ws.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {validationErrors.workspaceId && (
                <FieldError>{validationErrors.workspaceId}</FieldError>
              )}
            </Field>

            <Field data-invalid={!!validationErrors.role}>
              <FieldLabel htmlFor="role">Role</FieldLabel>
              <Select
                value={formData.role}
                onValueChange={(v) => handleSelectChange("role", v)}
                disabled={isSubmitting}
              >
                <SelectTrigger id="role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="editor">Editor</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                </SelectContent>
              </Select>
              {validationErrors.role && <FieldError>{validationErrors.role}</FieldError>}
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
