"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldError,
  FieldDescription,
} from "@/components/ui/field";
import { FormTextField } from "@/components/form-text-field";
import { Switch } from "@/components/ui/switch";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EntityDeleteDialog } from "@/components/entity-delete-dialog";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import { DetailFormState } from "@/components/detail-form-state";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useRouter } from "next/navigation";
import { type Workspace, type Provider } from "@platypus/schemas";
import {
  CONTEXT_MAX_LENGTH,
  DEFAULT_WORKSPACE_MAX_DAILY_SUMMARIES,
  WORKSPACE_MAX_DAILY_SUMMARIES_MAX,
  WORKSPACE_MAX_DAILY_SUMMARIES_MIN,
} from "@platypus/schemas";
import { retractFieldError } from "@/lib/form-errors";
import {
  canListOrgMembers,
  canManageWorkspaceDelegation,
} from "@/lib/authorization";
import { useAuth } from "@/components/auth-provider";
import { toast } from "sonner";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import {
  FieldSkeleton,
  FooterSkeleton,
  FormSkeletonGroup,
  FormSkeletonSet,
  TextareaSkeleton,
} from "@/components/form-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { orgRoutes, workspaceRoutes } from "@/lib/routes";

interface WorkspaceFormProps {
  classNames?: string;
  orgId: string;
  workspaceId?: string;
}

// providerSelfManagement and mcpSelfManagement are deliberately excluded:
// this form has no field that retracts an error keyed to them.
const RETRACTABLE_FIELDS = [
  "name",
  "ownerId",
  "context",
  "taskModelProviderId",
  "memoryExtractionProviderId",
  "memoryEmbeddingProviderId",
  "maxDailySummaries",
] as const;

type WorkspaceFormData = {
  name: string;
  context: string;
  ownerId: string;
  taskModelProviderId: string | null;
  memoryExtractionProviderId: string | null;
  memoryEmbeddingProviderId: string | null;
  maxDailySummaries: number;
  providerSelfManagement: boolean;
  mcpSelfManagement: boolean;
};

/** A delegation flag: label and description, its Switch on the right. */
const DelegationRowSkeleton = () => (
  <div className="flex w-full items-center justify-between gap-3">
    <div className="flex flex-1 flex-col gap-1.5">
      <Skeleton className="h-3.5 w-44" />
      <Skeleton className="h-3.5 w-3/4" />
    </div>
    <Skeleton className="h-[1.15rem] w-8 shrink-0 rounded-full" />
  </div>
);

const WorkspaceFormSkeleton = ({
  className,
  editing,
  delegation,
}: {
  className?: string;
  editing: boolean;
  delegation: boolean;
}) => (
  <div className={className}>
    <FormSkeletonSet>
      <FormSkeletonGroup>
        <FieldSkeleton />
        {!editing && <FieldSkeleton description={1} />}
        <TextareaSkeleton counter description={1} />
        {editing && (
          <>
            <FieldSkeleton description={2} />
            <FieldSkeleton description={2} />
            <FieldSkeleton description={2} />
            <FieldSkeleton description={1} />
            {delegation && (
              <>
                <DelegationRowSkeleton />
                <DelegationRowSkeleton />
              </>
            )}
          </>
        )}
      </FormSkeletonGroup>
    </FormSkeletonSet>
    <FooterSkeleton buttons={editing ? 2 : 1} />
  </div>
);

const WorkspaceForm = ({
  classNames,
  orgId,
  workspaceId,
}: WorkspaceFormProps) => {
  const { user, actor, isAuthLoading } = useAuth();
  const canListMembers = canListOrgMembers(actor);
  const canManageDelegation = canManageWorkspaceDelegation(actor);
  const router = useRouter();

  // Fetch providers
  const { data: providersData, isLoading: providersLoading } = useScopedSWR<{
    results: Provider[];
  }>("providers", workspaceId ? { orgId, workspaceId } : null);
  const providers = providersData?.results || [];

  // Org members, used to assign an owner when creating a workspace (ADR-0008).
  // Only admins can create workspaces and the members endpoint is admin-only.
  const { data: membersData, isLoading: membersLoading } = useScopedSWR<{
    results: { userId: string; user: { name: string; email: string } }[];
  }>("members", !workspaceId && canListMembers ? { orgId } : null);
  const members = membersData?.results || [];

  // Owner options for the create form. A super-admin acting on an org they're
  // not enrolled in (e.g. a brand-new org with no members) won't appear in
  // /members, but the backend lets them own a workspace by defaulting to
  // themselves (ADR-0008). Always offer the current user so the "defaults to
  // you" default resolves to a real, selectable option.
  const ownerOptions =
    user && !members.some((m) => m.userId === user.id)
      ? [
          { userId: user.id, user: { name: user.name, email: user.email } },
          ...members,
        ]
      : members;

  const {
    loadState,
    formData,
    setFormData,
    validationErrors,
    setValidationErrors,
    isSubmitting,
    canSubmit,
    handleChange,
    toFieldChange,
    submit,
  } = useEntityForm<WorkspaceFormData, Workspace, Workspace>({
    initialData: {
      name: "",
      context: "",
      // Default the owner to the current user when creating. The session is
      // usually cached, so `user` is available synchronously on first render;
      // the useResetOnChange below covers the case where it loads later.
      ownerId: (!workspaceId && user?.id) || ("" as string),
      taskModelProviderId: null as string | null,
      memoryExtractionProviderId: null as string | null,
      memoryEmbeddingProviderId: null as string | null,
      maxDailySummaries: DEFAULT_WORKSPACE_MAX_DAILY_SUMMARIES,
      providerSelfManagement: false,
      mcpSelfManagement: false,
    },
    entity: "workspaces",
    scope: { orgId },
    id: workspaceId,
    fromRecord: (workspace) => ({
      name: workspace.name,
      context: workspace.context || "",
      ownerId: workspace.ownerId,
      taskModelProviderId: workspace.taskModelProviderId || null,
      memoryExtractionProviderId: workspace.memoryExtractionProviderId || null,
      memoryEmbeddingProviderId: workspace.memoryEmbeddingProviderId || null,
      maxDailySummaries:
        workspace.maxDailySummaries ?? DEFAULT_WORKSPACE_MAX_DAILY_SUMMARIES,
      providerSelfManagement: workspace.providerSelfManagement ?? false,
      mcpSelfManagement: workspace.mcpSelfManagement ?? false,
    }),
    retractableFields: RETRACTABLE_FIELDS,
    buildPayload: (data) =>
      workspaceId
        ? {
            name: data.name,
            context: data.context || null,
            taskModelProviderId: data.taskModelProviderId,
            memoryExtractionProviderId: data.memoryExtractionProviderId,
            memoryEmbeddingProviderId: data.memoryEmbeddingProviderId,
            maxDailySummaries: data.maxDailySummaries,
            // Admin-only; the backend strips these for non-admins (ADR-0006).
            providerSelfManagement: data.providerSelfManagement,
            mcpSelfManagement: data.mcpSelfManagement,
          }
        : {
            name: data.name,
            context: data.context || null,
            // ADR-0008: an admin assigns the owner; defaults to themselves.
            ownerId: data.ownerId || user?.id,
          },
    onSuccess: (data) => {
      if (workspaceId) {
        toast.success("Workspace updated");
        router.refresh();
      } else {
        toast.success("Workspace created");
        router.push(workspaceRoutes(orgId, data.id).root);
      }
    },
  });

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    openDeleteDialog,
    handleDelete,
  } = useEntityDelete<Workspace>({
    entity: "workspaces",
    scope: { orgId },
    id: workspaceId,
    successMessage: "Workspace deleted",
    onSuccess: () => {
      // A full document load, deliberately — see the matching note in
      // `organization-form.tsx`. The Workspace this view is scoped to is
      // gone, and a client-side transition would keep the app shell (and its
      // cached payload for the deleted Workspace) alive around it.
      window.location.href = orgRoutes(orgId).root;
    },
    onError: (message, _outcome, { close }) => {
      toast.error(message);
      close();
    },
  });

  // When creating, default the owner to the current admin until they pick
  // another member.
  useResetOnChange(`${workspaceId ?? ""}:${user?.id ?? ""}`, () => {
    if (!workspaceId && user) {
      setFormData((prev) =>
        prev.ownerId ? prev : { ...prev, ownerId: user.id },
      );
    }
  });

  return (
    <DetailFormState
      {...loadState}
      // The provider selects (edit) and the Owner select (create) resolve
      // their values against these lists, so they'd render blank or partial
      // without them.
      isLoading={
        providersLoading ||
        membersLoading ||
        // Whether the members read runs hangs on the membership, which is
        // still resolving on a hard refresh.
        (!workspaceId && isAuthLoading) ||
        loadState.isLoading
      }
      subject="workspace"
      skeleton={
        <WorkspaceFormSkeleton
          className={classNames}
          editing={!!workspaceId}
          delegation={canManageDelegation}
        />
      }
      backHref={
        workspaceId
          ? workspaceRoutes(orgId, workspaceId).root
          : orgRoutes(orgId).root
      }
      backLabel="Back to workspace"
    >
      <div className={classNames}>
        <FieldSet className="mb-6">
          <FieldGroup>
            <FormTextField
              label="Name"
              name="name"
              placeholder="Workspace name"
              value={formData.name}
              onChange={toFieldChange("name")}
              disabled={isSubmitting}
              error={validationErrors.name}
              autoFocus
            />

            {/* ADR-0008: on creation an admin assigns the workspace owner. */}
            {!workspaceId && (
              <Field data-invalid={!!validationErrors.ownerId}>
                <FieldLabel htmlFor="ownerId">Owner</FieldLabel>
                <Select
                  value={formData.ownerId || undefined}
                  onValueChange={(value) => {
                    setValidationErrors((prev) =>
                      retractFieldError(prev, "ownerId"),
                    );
                    setFormData((prevData) => ({
                      ...prevData,
                      ownerId: value,
                    }));
                  }}
                  disabled={isSubmitting}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select an owner" />
                  </SelectTrigger>
                  <SelectContent>
                    {ownerOptions.map((m) => (
                      <SelectItem key={m.userId} value={m.userId}>
                        {m.user.name || m.user.email}
                        {m.userId === user?.id ? " (you)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  The member who will own this workspace. Defaults to you.
                </FieldDescription>
                {validationErrors.ownerId && (
                  <FieldError>{validationErrors.ownerId}</FieldError>
                )}
              </Field>
            )}

            <Field data-invalid={!!validationErrors.context}>
              <ExpandableTextarea
                id="context"
                label="Context"
                placeholder="Optional context for this workspace"
                value={formData.context}
                onChange={handleChange}
                disabled={isSubmitting}
                aria-invalid={!!validationErrors.context}
                className="!font-mono"
                maxLength={CONTEXT_MAX_LENGTH}
              />
              <FieldDescription>
                Additional context about this workspace included in all chats in
                this workspace
              </FieldDescription>
              {validationErrors.context && (
                <FieldError>{validationErrors.context}</FieldError>
              )}
            </Field>

            {workspaceId && (
              <Field data-invalid={!!validationErrors.taskModelProviderId}>
                <FieldLabel htmlFor="taskModelProviderId">
                  Task Model Provider
                </FieldLabel>
                <Select
                  value={formData.taskModelProviderId || "none"}
                  onValueChange={(value) => {
                    setValidationErrors((prev) =>
                      retractFieldError(prev, "taskModelProviderId"),
                    );
                    setFormData((prevData) => ({
                      ...prevData,
                      taskModelProviderId: value === "none" ? null : value,
                    }));
                  }}
                  disabled={isSubmitting}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      None (use chat provider)
                    </SelectItem>
                    {providers.map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        {provider.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Provider to use for generating chat titles and tags. If not
                  set, each chat will use its own provider for metadata
                  generation.
                </FieldDescription>
                {validationErrors.taskModelProviderId && (
                  <FieldError>
                    {validationErrors.taskModelProviderId}
                  </FieldError>
                )}
              </Field>
            )}

            {workspaceId && (
              <Field
                data-invalid={!!validationErrors.memoryExtractionProviderId}
              >
                <FieldLabel htmlFor="memoryExtractionProviderId">
                  Memory Extraction Provider
                </FieldLabel>
                <Select
                  value={formData.memoryExtractionProviderId || "none"}
                  onValueChange={(value) => {
                    setValidationErrors((prev) =>
                      retractFieldError(prev, "memoryExtractionProviderId"),
                    );
                    setFormData((prevData) => ({
                      ...prevData,
                      memoryExtractionProviderId:
                        value === "none" ? null : value,
                    }));
                  }}
                  disabled={isSubmitting}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Disabled</SelectItem>
                    {providers
                      .filter((p) => p.memoryExtractionModelId)
                      .map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>
                          {provider.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Provider to use for extracting memories from conversations.
                  Enable memory extraction on a provider to see it here.
                </FieldDescription>
                {validationErrors.memoryExtractionProviderId && (
                  <FieldError>
                    {validationErrors.memoryExtractionProviderId}
                  </FieldError>
                )}
              </Field>
            )}

            {workspaceId && (
              <Field
                data-invalid={!!validationErrors.memoryEmbeddingProviderId}
              >
                <FieldLabel htmlFor="memoryEmbeddingProviderId">
                  Memory Embedding Provider
                </FieldLabel>
                <Select
                  value={formData.memoryEmbeddingProviderId || "none"}
                  onValueChange={(value) => {
                    setValidationErrors((prev) =>
                      retractFieldError(prev, "memoryEmbeddingProviderId"),
                    );
                    setFormData((prevData) => ({
                      ...prevData,
                      memoryEmbeddingProviderId:
                        value === "none" ? null : value,
                    }));
                  }}
                  disabled={isSubmitting}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Disabled</SelectItem>
                    {providers
                      .filter(
                        (p) =>
                          (p as { embeddingModelId?: string }).embeddingModelId,
                      )
                      .map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>
                          {provider.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Provider to use for generating memory embeddings. Required for
                  semantic memory search. Set an embedding model ID on a
                  provider to see it here.
                </FieldDescription>
                {validationErrors.memoryEmbeddingProviderId && (
                  <FieldError>
                    {validationErrors.memoryEmbeddingProviderId}
                  </FieldError>
                )}
              </Field>
            )}

            {workspaceId && (
              <FormTextField
                label="Memory Summary Retention"
                name="maxDailySummaries"
                type="number"
                min={WORKSPACE_MAX_DAILY_SUMMARIES_MIN}
                max={WORKSPACE_MAX_DAILY_SUMMARIES_MAX}
                value={String(formData.maxDailySummaries)}
                onChange={(value) => {
                  setValidationErrors((prev) =>
                    retractFieldError(prev, "maxDailySummaries"),
                  );
                  setFormData((prevData) => ({
                    ...prevData,
                    maxDailySummaries:
                      parseInt(value) || DEFAULT_WORKSPACE_MAX_DAILY_SUMMARIES,
                  }));
                }}
                disabled={isSubmitting}
                error={validationErrors.maxDailySummaries}
                description="Maximum number of daily memory summaries to retain (7-365, default 90 days)."
              />
            )}

            {/* Delegation flags (ADR-0006) — admin-only. When off, only org
              admins may configure the respective resource; when on, the
              workspace owner may self-manage it. */}
            {workspaceId && canManageDelegation && (
              <>
                <Field
                  orientation="horizontal"
                  className="items-center justify-between"
                >
                  <div>
                    <FieldLabel htmlFor="providerSelfManagement">
                      Owner-managed providers
                    </FieldLabel>
                    <FieldDescription>
                      Let the workspace owner create and edit workspace-scoped
                      providers. Off by default (org admins only).
                    </FieldDescription>
                  </div>
                  <Switch
                    id="providerSelfManagement"
                    checked={formData.providerSelfManagement}
                    disabled={isSubmitting}
                    onCheckedChange={(checked) =>
                      setFormData((prev) => ({
                        ...prev,
                        providerSelfManagement: checked,
                      }))
                    }
                  />
                </Field>

                <Field
                  orientation="horizontal"
                  className="items-center justify-between"
                >
                  <div>
                    <FieldLabel htmlFor="mcpSelfManagement">
                      Owner-managed MCP servers
                    </FieldLabel>
                    <FieldDescription>
                      Let the workspace owner register and authorize their own
                      MCP servers (e.g. personal-credential integrations). Off
                      by default (org admins only).
                    </FieldDescription>
                  </div>
                  <Switch
                    id="mcpSelfManagement"
                    checked={formData.mcpSelfManagement}
                    disabled={isSubmitting}
                    onCheckedChange={(checked) =>
                      setFormData((prev) => ({
                        ...prev,
                        mcpSelfManagement: checked,
                      }))
                    }
                  />
                </Field>
              </>
            )}
          </FieldGroup>
        </FieldSet>

        <FormFooterButtons
          submitText="Save"
          onSubmit={() => void submit()}
          submitDisabled={isSubmitting || !canSubmit}
          submitClassName=""
          deleteVisible={!!workspaceId}
          deleteDisabled={isSubmitting}
          deleteClassName=""
          onDelete={openDeleteDialog}
        />

        <EntityDeleteDialog
          open={isDeleteDialogOpen}
          onOpenChange={setIsDeleteDialogOpen}
          title="Delete Workspace"
          description="Are you sure you want to delete this workspace? This action cannot be undone."
          confirmPhrase="Delete workspace"
          onConfirm={handleDelete}
          loading={isDeleting}
        />
      </div>
    </DetailFormState>
  );
};

export { WorkspaceForm };
