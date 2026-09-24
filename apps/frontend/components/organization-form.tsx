"use client";

import {
  Field,
  FieldGroup,
  FieldSet,
  FieldError,
  FieldDescription,
} from "@/components/ui/field";
import { FormTextField } from "@/components/form-text-field";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { EntityDeleteDialog } from "@/components/entity-delete-dialog";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import { DetailFormState } from "@/components/detail-form-state";
import {
  FieldSkeleton,
  FooterSkeleton,
  FormSkeletonGroup,
  FormSkeletonSet,
  TextareaSkeleton,
} from "@/components/form-skeleton";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useRouter } from "next/navigation";
import { type Organization } from "@platypus/schemas";
import { ORGANIZATION_IDENTITY_CONTEXT_MAX_LENGTH } from "@platypus/schemas";
import { toast } from "sonner";
import { orgRoutes } from "@/lib/routes";

interface OrganizationFormProps {
  classNames?: string;
  orgId?: string;
}

const RETRACTABLE_FIELDS = ["name", "identityContext"] as const;

const INITIAL_DATA = {
  name: "",
  identityContext: "",
};

const OrganizationForm = ({ classNames, orgId }: OrganizationFormProps) => {
  const router = useRouter();

  const {
    loadState,
    formData,
    validationErrors,
    isSubmitting,
    canSubmit,
    handleChange,
    toFieldChange,
    submit,
  } = useEntityForm<typeof INITIAL_DATA, Organization, Organization>({
    initialData: INITIAL_DATA,
    entity: "organizations",
    scope: {},
    id: orgId,
    fromRecord: (organization) => ({
      name: organization.name,
      identityContext: organization.identityContext ?? "",
    }),
    retractableFields: RETRACTABLE_FIELDS,
    // identityContext is update-only (the create schema accepts name only).
    buildPayload: (data) =>
      orgId
        ? { name: data.name, identityContext: data.identityContext || null }
        : { name: data.name },
    onSuccess: (data) => {
      if (orgId) {
        toast.success("Organization updated");
        router.refresh();
      } else {
        toast.success("Organization created");
        router.push(orgRoutes(data.id).root);
      }
    },
  });

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    openDeleteDialog,
    handleDelete,
  } = useEntityDelete({
    entity: "organizations",
    scope: {},
    id: orgId,
    successMessage: "Organization deleted",
    onSuccess: () => {
      // A full document load, deliberately, not `router.push`. The
      // Organization this view is scoped to no longer exists, and a
      // client-side transition keeps the app shell alive — the cached RSC
      // payload and SWR entries for the deleted Org included, which the
      // surrounding layout would go on rendering. Reloading rebuilds
      // everything from a server that now agrees the Org is gone.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = `/`;
    },
    onError: (message, _outcome, { close }) => {
      toast.error(message);
      close();
    },
  });

  return (
    <DetailFormState
      {...loadState}
      subject="organization"
      skeleton={
        <div className={classNames}>
          <FormSkeletonSet>
            <FormSkeletonGroup>
              <FieldSkeleton />
              {orgId && <TextareaSkeleton counter description={3} />}
            </FormSkeletonGroup>
          </FormSkeletonSet>
          <FooterSkeleton buttons={orgId ? 2 : 1} />
        </div>
      }
      backHref={orgId ? orgRoutes(orgId).root : "/"}
      backLabel="Back to organization"
    >
      <div className={classNames}>
        <FieldSet className="mb-6">
          <FieldGroup>
            <FormTextField
              label="Name"
              name="name"
              placeholder="Organization name"
              value={formData.name}
              onChange={toFieldChange("name")}
              disabled={isSubmitting}
              error={validationErrors.name}
              autoFocus
            />

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
                  maxLength={ORGANIZATION_IDENTITY_CONTEXT_MAX_LENGTH}
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
          onSubmit={() => void submit()}
          submitDisabled={isSubmitting || !canSubmit}
          submitClassName=""
          deleteVisible={!!orgId}
          deleteDisabled={isSubmitting}
          deleteClassName=""
          onDelete={openDeleteDialog}
        />

        <EntityDeleteDialog
          open={isDeleteDialogOpen}
          onOpenChange={setIsDeleteDialogOpen}
          title="Delete Organization"
          description="Are you sure you want to delete this organization? This action cannot be undone."
          confirmPhrase="Delete organization"
          onConfirm={handleDelete}
          loading={isDeleting}
        />
      </div>
    </DetailFormState>
  );
};

export { OrganizationForm };
