"use client";

import { useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DetailFormState } from "@/components/detail-form-state";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { fetcher, joinUrl } from "@/lib/utils";
import { writeAt } from "@/lib/api-write";
import {
  applyDeleteOutcome,
  applyWriteOutcome,
} from "@/lib/apply-write-outcome";
import { retractFieldError } from "@/lib/form-errors";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import useSWR, { useSWRConfig } from "swr";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import type { Organization, Workspace, Context } from "@platypus/schemas";

interface WorkspaceWithOrg extends Workspace {
  organizationName?: string;
}

export const WorkspaceContextForm = ({ contextId }: { contextId?: string }) => {
  const router = useRouter();
  const backendUrl = useBackendUrl();
  const { user } = useAuth();
  const { mutate: globalMutate } = useSWRConfig();

  const contextsUrl = joinUrl(backendUrl, "/users/me/contexts");
  const contextUrl = contextId
    ? joinUrl(backendUrl, `/users/me/contexts/${contextId}`)
    : null;

  const [formData, setFormData] = useState({
    content: "",
    workspaceId: "",
  });
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  const clearError = (field: string) => {
    setValidationErrors((prev) => retractFieldError(prev, field));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.workspaceId) {
      setValidationErrors({ workspaceId: "Select a workspace" });
      return;
    }

    setIsSubmitting(true);
    setValidationErrors({});

    const result =
      contextId && contextUrl
        ? await writeAt<Context>(contextUrl, {
            method: "PUT",
            data: { content: formData.content },
            revalidateKeys: [contextsUrl, contextUrl],
          })
        : await writeAt<Context>(contextsUrl, {
            method: "POST",
            data: {
              content: formData.content,
              workspaceId: formData.workspaceId,
            },
            revalidateKeys: [contextsUrl],
          });

    await applyWriteOutcome(result, {
      mutate: globalMutate,
      setValidationErrors,
      // A create's 409 is "you already have a context for this workspace", so
      // it belongs on the Workspace field; an update has no such field.
      conflictField: contextId ? null : "workspaceId",
      onSuccess: () => {
        toast.success(
          contextId ? "Workspace context updated" : "Workspace context created",
        );
        router.push("/settings/contexts");
      },
    });

    setIsSubmitting(false);
  };

  const handleDelete = async () => {
    if (!contextUrl) return;

    setIsDeleting(true);
    setDeleteError(null);
    const result = await writeAt(contextUrl, {
      method: "DELETE",
      revalidateKeys: [contextsUrl],
    });

    await applyDeleteOutcome(result, {
      mutate: globalMutate,
      onSuccess: () => {
        toast.success("Context deleted");
        router.push("/settings/contexts");
      },
      onError: (message) => {
        setDeleteError(message);
        setIsDeleting(false);
      },
    });
  };

  return (
    <DetailFormState
      isLoading={!!contextId && contextLoading}
      error={contextError}
      data={contextData}
      subject="workspace context"
      backHref="/settings/contexts"
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
                    onValueChange={(value) => {
                      clearError("workspaceId");
                      setFormData({ ...formData, workspaceId: value });
                    }}
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
                onChange={(e) => {
                  clearError("content");
                  setFormData({ ...formData, content: e.target.value });
                }}
                className="!font-mono"
                maxLength={1000}
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
          onDelete={() => setIsDeleteDialogOpen(true)}
        />

        <ConfirmDialog
          open={isDeleteDialogOpen}
          onOpenChange={(open) => {
            setIsDeleteDialogOpen(open);
            if (!open) setDeleteError(null);
          }}
          title="Delete Context"
          description="Are you sure you want to delete this context? This action cannot be undone."
          confirmLabel="Delete"
          confirmVariant="destructive"
          onConfirm={handleDelete}
          loading={isDeleting}
          error={deleteError}
        />
      </form>
    </DetailFormState>
  );
};
