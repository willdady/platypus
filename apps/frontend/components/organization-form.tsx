"use client";

import { FieldGroup, FieldSet } from "@/components/ui/field";
import { FormTextField } from "@/components/form-text-field";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import { DetailFormState } from "@/components/detail-form-state";
import { hardNavigate } from "@/components/unsaved-changes-guard";
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
import { appRoutes, orgRoutes, withBasePath } from "@/lib/routes";

type OrganizationFormProps = {
  classNames?: string;
  orgId?: string;
};

const RETRACTABLE_FIELDS = ["name", "identityContext"] as const;

const INITIAL_DATA = {
  name: "",
  identityContext: "",
};

function OrganizationForm({ classNames, orgId }: OrganizationFormProps) {
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
    successMessage: () =>
      orgId ? "Organization updated" : "Organization created",
    onSuccess: (data) => {
      if (orgId) {
        router.refresh();
      } else {
        router.push(orgRoutes(data.id).root);
      }
    },
  });

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    deleteError,
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
      hardNavigate(withBasePath(appRoutes.home));
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
      <form
        noValidate
        className={classNames}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
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
              <ExpandableTextarea
                id="identityContext"
                label="Organization identity / context"
                placeholder="Optional identity or context for this organization, shared across all workspaces"
                value={formData.identityContext}
                onChange={handleChange}
                disabled={isSubmitting}
                className="!font-mono"
                maxLength={ORGANIZATION_IDENTITY_CONTEXT_MAX_LENGTH}
                error={validationErrors.identityContext}
                description={
                  <>
                    Framing added early in the system prompt for every chat
                    across the organization — who you are, what you do. This is
                    context, not a security control (set provider security
                    guardrails for that).
                  </>
                }
              />
            )}
          </FieldGroup>
        </FieldSet>

        <FormFooterButtons
          type="submit"
          submitText="Save"
          pending={isSubmitting}
          submitDisabled={isSubmitting || !canSubmit}
          deleteVisible={!!orgId}
          deleteDisabled={isSubmitting}
          onDelete={openDeleteDialog}
        />

        <DeleteConfirmDialog
          open={isDeleteDialogOpen}
          onOpenChange={setIsDeleteDialogOpen}
          noun="organization"
          consequence="This deletes every Workspace in it, along with their Chats, Agents, files and Sandboxes, and every Shared resource. Depending on its backend, deleting a Sandbox can also erase everything stored in it."
          requireTypedConfirmation
          onConfirm={handleDelete}
          loading={isDeleting}
          error={deleteError}
        />
      </form>
    </DetailFormState>
  );
}

export { OrganizationForm };
