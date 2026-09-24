"use client";

import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useRouter } from "next/navigation";
import {
  Field,
  FieldError,
  FieldLabel,
  FieldGroup,
  FieldSet,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { EntityDeleteDialog } from "@/components/entity-delete-dialog";
import { DetailFormState } from "@/components/detail-form-state";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { fetcher, joinUrl } from "@/lib/utils";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import useSWR from "swr";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import {
  FieldSkeleton,
  FooterSkeleton,
  FormSkeletonGroup,
  FormSkeletonSet,
  TextareaSkeleton,
} from "@/components/form-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import type { Organization, Workspace, Context } from "@platypus/schemas";
import { CONTEXT_MAX_LENGTH } from "@platypus/schemas";
import { userRoutes } from "@/lib/routes";

interface WorkspaceWithOrg extends Workspace {
  organizationName?: string;
}

const RETRACTABLE_FIELDS = ["content", "workspaceId"] as const;

const INITIAL_DATA = {
  content: "",
  workspaceId: "",
};

/** An edit shows the fixed Organization and Workspace as plain text. */
const ReadOnlyFieldSkeleton = () => (
  <div className="flex w-full flex-col gap-3">
    <Skeleton className="h-3.5 w-24" />
    <Skeleton className="h-3.5 w-40" />
  </div>
);

const WorkspaceContextFormSkeleton = ({ editing }: { editing: boolean }) => (
  <div>
    <FormSkeletonSet>
      <FormSkeletonGroup className="gap-4">
        {editing ? (
          <>
            <ReadOnlyFieldSkeleton />
            <ReadOnlyFieldSkeleton />
          </>
        ) : (
          <FieldSkeleton />
        )}
        <TextareaSkeleton counter />
      </FormSkeletonGroup>
    </FormSkeletonSet>
    <FooterSkeleton buttons={editing ? 2 : 1} />
  </div>
);

export const WorkspaceContextForm = ({ contextId }: { contextId?: string }) => {
  const router = useRouter();
  const backendUrl = useBackendUrl();
  const { user } = useAuth();

  const contextsUrl = joinUrl(backendUrl, "/users/me/contexts");

  const {
    record: contextData,
    loadState,
    formData,
    validationErrors,
    setValidationErrors,
    isSubmitting,
    setField,
    handleChange,
    submit,
  } = useEntityForm<typeof INITIAL_DATA, Context, Context>({
    initialData: INITIAL_DATA,
    // User-scoped, so the root scope: `/users/me/contexts`.
    entity: "users/me/contexts",
    scope: {},
    id: contextId,
    fromRecord: (context) => ({
      content: context.content,
      workspaceId: context.workspaceId || "",
    }),
    retractableFields: RETRACTABLE_FIELDS,
    // The Workspace is fixed once the context exists.
    buildPayload: (data) =>
      contextId
        ? { content: data.content }
        : { content: data.content, workspaceId: data.workspaceId },
    // A create's 409 is "you already have a context for this workspace", so
    // it belongs on the Workspace field; an update has no such field.
    conflictField: contextId ? null : "workspaceId",
    successMessage: () =>
      contextId ? "Workspace context updated" : "Workspace context created",
    onSuccess: () => router.push(userRoutes.contexts),
  });

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    deleteError,
    openDeleteDialog,
    handleDelete,
  } = useEntityDelete({
    entity: "users/me/contexts",
    scope: {},
    id: contextId,
    successMessage: "Context deleted",
    onSuccess: () => router.push(userRoutes.contexts),
  });

  // Fetch organizations
  const {
    data: orgs,
    error: orgsError,
    mutate: mutateOrgs,
  } = useSWR<{ results: Organization[] }>(
    user ? joinUrl(backendUrl, "/organizations") : null,
    fetcher,
  );

  // Fetch all contexts to filter out workspaces that already have contexts
  const { data: allContexts, error: allContextsError } = useSWR<{
    results: Context[];
  }>(user ? contextsUrl : null, fetcher);

  // Every workspace across every organization the user belongs to. The API has
  // no user-scoped workspace route, so the per-organization fan-out lives in
  // one SWR fetcher: the organization list is the key, so a changed list is a
  // new request, and a failure reaches the form as `error` rather than a
  // `console.error` in an effect that cannot cancel itself.
  const fetchOrgWorkspaces = async (
    organizations: Organization[] | null,
  ): Promise<WorkspaceWithOrg[]> => {
    if (!organizations) return [];

    const perOrg = await Promise.all(
      organizations.map(async (org) => {
        const data = (await fetcher(
          joinUrl(backendUrl, `/organizations/${org.id}/workspaces`),
        )) as { results: Workspace[] };
        return data.results.map((workspace) => ({
          ...workspace,
          organizationName: org.name,
        }));
      }),
    );
    return perOrg.flat();
  };

  const {
    data: workspacesData,
    error: workspacesError,
    mutate: mutateWorkspaces,
  } = useSWR<WorkspaceWithOrg[]>(orgs?.results ?? null, fetchOrgWorkspaces);
  const workspaces = workspacesData ?? [];

  // The picker depends on two reads — the organizations and their workspaces —
  // and a failure in either leaves it with nothing to offer, so both surface
  // the same notice and Retry.
  const workspacesLoadError = orgsError ?? workspacesError;
  // Until both the workspaces and the contexts that filter them land, the
  // picker would offer nothing (or too much) with no hint why. Keyed on data,
  // not `isLoading`: the fan-out's key stays null until the organizations
  // arrive, and SWR reports a null key as not loading. No organizations means
  // no fan-out at all (SWR never fetches an empty-array key), so nothing to wait on.
  const workspacesLoading =
    !workspacesLoadError &&
    (orgs === undefined ||
      (orgs.results.length > 0 && workspacesData === undefined) ||
      (allContexts === undefined && !allContextsError));
  const retryWorkspaces = () => {
    mutateOrgs();
    mutateWorkspaces();
  };

  // Filter out workspaces that already have contexts (unless we're editing that context)
  const existingWorkspaceIds = new Set(
    allContexts?.results
      .filter((c) => c.workspaceId && c.id !== contextId)
      .map((c) => c.workspaceId) || [],
  );
  const availableWorkspaces = workspaces.filter(
    (w) => !existingWorkspaceIds.has(w.id),
  );

  const groupedWorkspaces = availableWorkspaces.reduce<
    Record<string, WorkspaceWithOrg[]>
  >((acc, workspace) => {
    const orgName = workspace.organizationName || "Unknown Organization";
    if (!acc[orgName]) acc[orgName] = [];
    acc[orgName].push(workspace);
    return acc;
  }, {});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.workspaceId) {
      setValidationErrors({ workspaceId: "Select a workspace" });
      return;
    }

    await submit();
  };

  return (
    <DetailFormState
      {...loadState}
      subject="workspace context"
      skeleton={<WorkspaceContextFormSkeleton editing={!!contextId} />}
      backHref={userRoutes.contexts}
      backLabel="Back to contexts"
    >
      <form onSubmit={handleSubmit}>
        <FieldSet className="mb-6">
          <FieldGroup className="gap-4">
            {contextId ? (
              <>
                <Field>
                  <FieldLabel>Organization</FieldLabel>
                  <div className="text-sm text-muted-foreground">
                    {(contextData as { organizationName?: string })
                      ?.organizationName || "\u00A0"}
                  </div>
                </Field>
                <Field>
                  <FieldLabel>Workspace</FieldLabel>
                  <div className="text-sm text-muted-foreground">
                    {(contextData as { workspaceName?: string })
                      ?.workspaceName || "\u00A0"}
                  </div>
                </Field>
              </>
            ) : (
              <Field data-invalid={!!validationErrors.workspaceId}>
                <FieldLabel htmlFor="workspace">Workspace</FieldLabel>
                {workspacesLoadError ? (
                  <div className="flex items-center gap-3 text-sm text-destructive">
                    <span>Couldn&apos;t load your workspaces.</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={retryWorkspaces}
                    >
                      Retry
                    </Button>
                  </div>
                ) : (
                  <Select
                    value={formData.workspaceId}
                    onValueChange={(value) => setField("workspaceId", value)}
                    disabled={workspacesLoading}
                  >
                    <SelectTrigger
                      id="workspace"
                      className="cursor-pointer"
                      aria-invalid={!!validationErrors.workspaceId}
                    >
                      <SelectValue
                        placeholder={
                          workspacesLoading
                            ? "Loading workspaces…"
                            : "Select workspace"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(groupedWorkspaces).map(
                        ([orgName, orgWorkspaces]) => (
                          <SelectGroup key={orgName}>
                            <SelectLabel>{orgName}</SelectLabel>
                            {orgWorkspaces.map((workspace) => (
                              <SelectItem
                                key={workspace.id}
                                value={workspace.id}
                                className="cursor-pointer"
                              >
                                {workspace.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                )}
                {validationErrors.workspaceId && (
                  <FieldError>{validationErrors.workspaceId}</FieldError>
                )}
              </Field>
            )}

            <Field data-invalid={!!validationErrors.content}>
              <ExpandableTextarea
                id="content"
                label="Content"
                placeholder="Enter project-specific context, team conventions, or workspace instructions..."
                value={formData.content}
                onChange={handleChange}
                className="!font-mono"
                maxLength={CONTEXT_MAX_LENGTH}
                error={validationErrors.content}
              />
            </Field>
          </FieldGroup>
        </FieldSet>

        <FormFooterButtons
          type="submit"
          submitText={contextId ? "Update" : "Save"}
          submitDisabled={isSubmitting}
          submitClassName=""
          deleteVisible={!!contextId}
          deleteDisabled={isSubmitting}
          deleteClassName=""
          onDelete={openDeleteDialog}
        />

        <EntityDeleteDialog
          open={isDeleteDialogOpen}
          onOpenChange={setIsDeleteDialogOpen}
          title="Delete Context"
          description="Are you sure you want to delete this context? This action cannot be undone."
          onConfirm={handleDelete}
          loading={isDeleting}
          error={deleteError}
        />
      </form>
    </DetailFormState>
  );
};
