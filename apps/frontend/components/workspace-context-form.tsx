"use client";

import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useRouter } from "next/navigation";
import {
  Field,
  FieldError,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldTitle,
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
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailFormState } from "@/components/detail-form-state";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { fetcher } from "@/lib/utils";
import { useBackendUrl } from "@/components/auth-provider";
import useSWR from "swr";
import { useScopedList } from "@/hooks/use-scoped-list";
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
import { scopedUrl, type Serialized } from "@/lib/api-write";

type WorkspaceWithOrg = {
  organizationName?: string;
} & Serialized<Workspace>;

const RETRACTABLE_FIELDS = ["content", "workspaceId"] as const;

const INITIAL_DATA: { content: string; workspaceId: string | null } = {
  content: "",
  workspaceId: null,
};

function ReadOnlyFieldSkeleton() {
  return (
    <div className="flex w-full flex-col gap-3">
      <Skeleton className="h-3.5 w-24" />
      <Skeleton className="h-3.5 w-40" />
    </div>
  );
}

function WorkspaceContextFormSkeleton({ editing }: { editing: boolean }) {
  return (
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
}

export function WorkspaceContextForm({ contextId }: { contextId?: string }) {
  const router = useRouter();
  const backendUrl = useBackendUrl();

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
    // why: contexts are user-scoped, so the root scope
    entity: "users/me/contexts",
    scope: {},
    id: contextId,
    fromRecord: (context) => ({
      content: context.content,
      workspaceId: context.workspaceId,
    }),
    retractableFields: RETRACTABLE_FIELDS,
    // why: the Workspace is fixed once the context exists
    buildPayload: (data) =>
      contextId
        ? { content: data.content }
        : { content: data.content, workspaceId: data.workspaceId },
    // why: a create's 409 means one context per Workspace, so it lands on the field
    conflictField: contextId ? null : "workspaceId",
    successMessage: () =>
      contextId ? "Workspace context updated" : "Workspace context created",
    onSuccess: () => router.push(userRoutes.contexts),
  });

  const { dialogProps, openDeleteDialog } = useEntityDelete({
    entity: "users/me/contexts",
    scope: {},
    id: contextId,
    successMessage: "Context deleted",
    onSuccess: () => router.push(userRoutes.contexts),
  });

  const {
    data: orgsData,
    results: orgs,
    error: orgsError,
    mutate: mutateOrgs,
  } = useScopedList<Organization>("organizations", {});

  const {
    data: allContextsData,
    results: allContexts,
    error: allContextsError,
  } = useScopedList<Context>("users/me/contexts", {});

  // why: no user-scoped route, so the org list keys one fan-out request
  const fetchOrgWorkspaces = async (
    organizations: Serialized<Organization>[] | null,
  ): Promise<WorkspaceWithOrg[]> => {
    if (!organizations) return [];

    const perOrg = await Promise.all(
      organizations.map(async (org) => {
        const data = await fetcher<{ results: Serialized<Workspace>[] }>(
          scopedUrl(backendUrl, "workspaces", { orgId: org.id }),
        );
        return data.results.map((workspace) => ({
          ...workspace,
          organizationName: org.name,
        }));
      }),
    );
    return perOrg.flat();
  };

  // why: raw useSWR, keyed on the org list useScopedSWR already gated
  const {
    data: workspacesData,
    error: workspacesError,
    mutate: mutateWorkspaces,
  } = useSWR<WorkspaceWithOrg[], unknown>(
    orgsData ? orgs : null,
    fetchOrgWorkspaces,
  );
  const workspaces = workspacesData ?? [];

  // why: either read failing leaves the picker empty, so both show one notice
  const workspacesLoadError = orgsError ?? workspacesError;
  // why: keyed on data — SWR reports a null fan-out key as not loading
  const workspacesLoading =
    !workspacesLoadError &&
    (orgsData === undefined ||
      (orgs.length > 0 && workspacesData === undefined) ||
      (allContextsData === undefined && !allContextsError));
  const retryWorkspaces = () => {
    void mutateOrgs();
    void mutateWorkspaces();
  };

  const existingWorkspaceIds = new Set(
    allContexts
      .filter((c) => c.workspaceId && c.id !== contextId)
      .map((c) => c.workspaceId),
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
                  <FieldTitle>Organization</FieldTitle>
                  <div className="text-sm text-muted-foreground">
                    {(contextData as { organizationName?: string })
                      ?.organizationName || "\u00A0"}
                  </div>
                </Field>
                <Field>
                  <FieldTitle>Workspace</FieldTitle>
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
                  <div
                    role="alert"
                    className="flex items-center gap-3 text-sm text-destructive"
                  >
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
                    value={formData.workspaceId ?? ""}
                    onValueChange={(value) => setField("workspaceId", value)}
                    disabled={workspacesLoading}
                  >
                    <SelectTrigger
                      id="workspace"
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
          </FieldGroup>
        </FieldSet>

        <FormFooterButtons
          type="submit"
          submitText={contextId ? "Update" : "Save"}
          pending={isSubmitting}
          submitDisabled={isSubmitting}
          deleteVisible={!!contextId}
          deleteDisabled={isSubmitting}
          onDelete={openDeleteDialog}
        />

        <DeleteConfirmDialog noun="context" {...dialogProps} />
      </form>
    </DetailFormState>
  );
}
