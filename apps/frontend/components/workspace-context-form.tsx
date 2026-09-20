"use client";

import { useResetOnChange } from "@/hooks/use-reset-on-change";
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
import { writeAt } from "@/lib/api-write";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import useSWR from "swr";
import { FormFooterButtons } from "@/components/form-footer-buttons";
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

export const WorkspaceContextForm = ({ contextId }: { contextId?: string }) => {
  const router = useRouter();
  const backendUrl = useBackendUrl();
  const { user } = useAuth();

  const contextsUrl = joinUrl(backendUrl, "/users/me/contexts");
  const contextUrl = contextId
    ? joinUrl(backendUrl, `/users/me/contexts/${contextId}`)
    : null;

  const {
    formData,
    setFormData,
    validationErrors,
    setValidationErrors,
    isSubmitting,
    setField,
    handleChange,
    submit,
  } = useEntityForm<typeof INITIAL_DATA, Context>({
    initialData: INITIAL_DATA,
    entity: "contexts",
    scope: {},
    id: contextId,
    retractableFields: RETRACTABLE_FIELDS,
    write: (data) =>
      contextId && contextUrl
        ? writeAt<Context>(contextUrl, {
            method: "PUT",
            data: { content: data.content },
            revalidateKeys: [contextsUrl, contextUrl],
          })
        : writeAt<Context>(contextsUrl, {
            method: "POST",
            data: {
              content: data.content,
              workspaceId: data.workspaceId,
            },
            revalidateKeys: [contextsUrl],
          }),
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
    entity: "contexts",
    scope: {},
    id: contextId,
    write: () =>
      writeAt(contextUrl as string, {
        method: "DELETE",
        revalidateKeys: [contextsUrl],
      }),
    successMessage: "Context deleted",
    onSuccess: () => router.push(userRoutes.contexts),
  });

  // Fetch existing context if editing
  const {
    data: contextData,
    error: contextError,
    isLoading: contextLoading,
  } = useSWR<Context>(contextId && user ? contextUrl : null, fetcher);

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
  const { data: allContexts } = useSWR<{ results: Context[] }>(
    user ? contextsUrl : null,
    fetcher,
  );

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
  const retryWorkspaces = () => {
    mutateOrgs();
    mutateWorkspaces();
  };

  // Set form data when editing
  useResetOnChange(contextData, () => {
    if (contextData) {
      setFormData({
        content: contextData.content,
        workspaceId: contextData.workspaceId || "",
      });
    }
  });

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
      isLoading={!!contextId && contextLoading}
      error={contextError}
      data={contextData}
      subject="workspace context"
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
                  >
                    <SelectTrigger
                      id="workspace"
                      className="cursor-pointer"
                      aria-invalid={!!validationErrors.workspaceId}
                    >
                      <SelectValue placeholder="Select workspace" />
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
