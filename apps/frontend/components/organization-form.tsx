"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldError,
  FieldDescription,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useRouter } from "next/navigation";
import { type Organization } from "@platypus/schemas";
import { fetcher, joinUrl } from "@/lib/utils";
import { canSubmitForm, retractFieldError } from "@/lib/form-errors";
import { writeEntity } from "@/lib/api-write";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import useSWR, { useSWRConfig } from "swr";

interface OrganizationFormProps {
  classNames?: string;
  orgId?: string;
}

const RETRACTABLE_FIELDS = ["name", "identityContext"] as const;

const OrganizationForm = ({ classNames, orgId }: OrganizationFormProps) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();
  const { mutate: globalMutate } = useSWRConfig();

  const { data: organization } = useSWR<Organization>(
    orgId && user ? joinUrl(backendUrl, `/organizations/${orgId}`) : null,
    fetcher,
  );

  const [formData, setFormData] = useState({
    name: "",
    identityContext: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useResetOnChange(organization, () => {
    if (organization) {
      setFormData({
        name: organization.name,
        identityContext: organization.identityContext ?? "",
      });
    }
  });

  const handleChange = (
    e:
      | React.ChangeEvent<HTMLInputElement>
      | React.ChangeEvent<HTMLTextAreaElement>,
  ) => {
    const { id, value } = e.target;

    // Clear the error for this field, including any reported against a path
    // inside it.
    setValidationErrors((prev) => retractFieldError(prev, id));

    setFormData((prevData) => ({
      ...prevData,
      [id]: value,
    }));
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setValidationErrors({});

    // identityContext is update-only (the create schema accepts name only).
    const payload = orgId
      ? {
          name: formData.name,
          identityContext: formData.identityContext || null,
        }
      : { name: formData.name };

    const result = await writeEntity<Organization>(
      backendUrl,
      "organizations",
      {},
      { id: orgId, data: payload },
    );

    switch (result.outcome) {
      case "success":
        result.revalidateKeys.forEach((key) => globalMutate(key));
        if (orgId) {
          toast.success("Organization updated");
          router.refresh();
        } else {
          toast.success("Organization created");
          router.push(`/${result.data.id}`);
        }
        break;
      case "invalid":
        setValidationErrors(result.fieldErrors);
        if (Object.keys(result.fieldErrors).length === 0) {
          toast.error(result.message);
        }
        break;
      case "conflict":
        setValidationErrors({ name: result.message });
        break;
      case "locked":
      case "notFound":
      case "error":
        toast.error(result.message);
        break;
    }

    setIsSubmitting(false);
  };

  const handleDelete = async () => {
    if (!orgId) return;

    setIsDeleting(true);
    const result = await writeEntity(
      backendUrl,
      "organizations",
      {},
      { id: orgId },
    );

    if (result.outcome === "success") {
      result.revalidateKeys.forEach((key) => globalMutate(key));
      toast.success("Organization deleted");
      window.location.href = `/`;
    } else {
      toast.error(result.message);
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  return (
    <div className={classNames}>
      <FieldSet className="mb-6">
        <FieldGroup>
          <Field data-invalid={!!validationErrors.name}>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              placeholder="Organization name"
              value={formData.name}
              onChange={handleChange}
              disabled={isSubmitting}
              aria-invalid={!!validationErrors.name}
              autoFocus
            />
            {validationErrors.name && (
              <FieldError>{validationErrors.name}</FieldError>
            )}
          </Field>

          {orgId && (
            <Field data-invalid={!!validationErrors.identityContext}>
              <ExpandableTextarea
                id="identityContext"
                label="Organization identity / context"
                placeholder="Optional identity or context for this organization, shared across all workspaces"
                value={formData.identityContext}
                onChange={handleChange}
                disabled={isSubmitting}
                aria-invalid={!!validationErrors.identityContext}
                className="!font-mono"
                maxLength={4000}
              />
              <FieldDescription>
                Framing added early in the system prompt for every chat across
                the organization — who you are, what you do. This is context,
                not a security control (set provider security guardrails for
                that).
              </FieldDescription>
              {validationErrors.identityContext && (
                <FieldError>{validationErrors.identityContext}</FieldError>
              )}
            </Field>
          )}
        </FieldGroup>
      </FieldSet>

      <div className="flex gap-2">
        <Button
          onClick={handleSubmit}
          disabled={
            isSubmitting || !canSubmitForm(validationErrors, RETRACTABLE_FIELDS)
          }
        >
          {orgId ? "Update" : "Save"}
        </Button>

        {orgId && (
          <Button
            variant="outline"
            onClick={() => setIsDeleteDialogOpen(true)}
            disabled={isSubmitting}
          >
            <Trash2 /> Delete
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete Organization"
        description="Are you sure you want to delete this organization? This action cannot be undone."
        confirmLabel="Delete"
        confirmVariant="destructive"
        confirmPhrase="Delete organization"
        onConfirm={handleDelete}
        loading={isDeleting}
      />
    </div>
  );
};

export { OrganizationForm };
