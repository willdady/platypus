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
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import { useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useRouter } from "next/navigation";
import { type Organization } from "@platypus/schemas";
import { fetcher, joinUrl } from "@/lib/utils";
import { canSubmitForm, retractFieldError } from "@/lib/form-errors";
import { writeEntity } from "@/lib/api-write";
import {
  applyWriteOutcome,
  applyDeleteOutcome,
} from "@/lib/apply-write-outcome";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
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

    await applyWriteOutcome(result, {
      mutate: globalMutate,
      setValidationErrors,
      onSuccess: (data) => {
        if (orgId) {
          toast.success("Organization updated");
          router.refresh();
        } else {
          toast.success("Organization created");
          router.push(`/${data.id}`);
        }
      },
    });

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

    await applyDeleteOutcome(result, {
      mutate: globalMutate,
      onSuccess: () => {
        toast.success("Organization deleted");
        // A full document load, deliberately, not `router.push`. The
        // Organization this view is scoped to no longer exists, and a
        // client-side transition keeps the app shell alive — the cached RSC
        // payload and SWR entries for the deleted Org included, which the
        // surrounding layout would go on rendering. Reloading rebuilds
        // everything from a server that now agrees the Org is gone.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = `/`;
      },
      onError: (message) => {
        toast.error(message);
        setIsDeleting(false);
        setIsDeleteDialogOpen(false);
      },
    });
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

      <FormFooterButtons
        submitText="Save"
        onSubmit={handleSubmit}
        submitDisabled={
          isSubmitting || !canSubmitForm(validationErrors, RETRACTABLE_FIELDS)
        }
        submitClassName=""
        deleteVisible={!!orgId}
        deleteDisabled={isSubmitting}
        deleteClassName=""
        onDelete={() => setIsDeleteDialogOpen(true)}
      />

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
