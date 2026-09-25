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
import { canManageWorkspaceDelegation } from "@/lib/authorization";
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
  workspaceId: string;
}

// providerSelfManagement and mcpSelfManagement are deliberately excluded:
// this form has no field that retracts an error keyed to them.
const RETRACTABLE_FIELDS = [
  "name",
  "context",
  "taskModelProviderId",
  "memoryExtractionProviderId",
  "memoryEmbeddingProviderId",
  "maxDailySummaries",
] as const;

type WorkspaceFormData = {
  name: string;
  context: string;
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
  delegation,
}: {
  className?: string;
  delegation: boolean;
}) => (
  <div className={className}>
    <FormSkeletonSet>
      <FormSkeletonGroup>
        <FieldSkeleton />
        <TextareaSkeleton counter description={1} />
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
      </FormSkeletonGroup>
    </FormSkeletonSet>
    <FooterSkeleton buttons={2} />
  </div>
);

const WorkspaceForm = ({
  classNames,
  orgId,
  workspaceId,
}: WorkspaceFormProps) => {
  const { actor } = useAuth();
  const canManageDelegation = canManageWorkspaceDelegation(actor);
  const router = useRouter();

  // Fetch providers
  const { data: providersData, isLoading: providersLoading } = useScopedSWR<{
    results: Provider[];
  }>("providers", { orgId, workspaceId });
  const providers = providersData?.results || [];

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
      taskModelProviderId: workspace.taskModelProviderId || null,
      memoryExtractionProviderId: workspace.memoryExtractionProviderId || null,
      memoryEmbeddingProviderId: workspace.memoryEmbeddingProviderId || null,
      maxDailySummaries:
        workspace.maxDailySummaries ?? DEFAULT_WORKSPACE_MAX_DAILY_SUMMARIES,
      providerSelfManagement: workspace.providerSelfManagement ?? false,
      mcpSelfManagement: workspace.mcpSelfManagement ?? false,
    }),
    retractableFields: RETRACTABLE_FIELDS,
    buildPayload: (data) => ({
      name: data.name,
      context: data.context || null,
      taskModelProviderId: data.taskModelProviderId,
      memoryExtractionProviderId: data.memoryExtractionProviderId,
      memoryEmbeddingProviderId: data.memoryEmbeddingProviderId,
      maxDailySummaries: data.maxDailySummaries,
      // Admin-only; the backend strips these for non-admins (ADR-0006).
      providerSelfManagement: data.providerSelfManagement,
      mcpSelfManagement: data.mcpSelfManagement,
    }),
    onSuccess: () => {
      toast.success("Workspace updated");
      router.refresh();
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

  return (
    <DetailFormState
      {...loadState}
      // The provider selects resolve their values against this list, so
      // they'd render blank or partial without it.
      isLoading={providersLoading || loadState.isLoading}
      subject="workspace"
      skeleton={
        <WorkspaceFormSkeleton
          className={classNames}
          delegation={canManageDelegation}
        />
      }
      backHref={workspaceRoutes(orgId, workspaceId).root}
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
                  <SelectItem value="none">None (use chat provider)</SelectItem>
                  {providers.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Provider to use for generating chat titles and tags. If not set,
                each chat will use its own provider for metadata generation.
              </FieldDescription>
              {validationErrors.taskModelProviderId && (
                <FieldError>{validationErrors.taskModelProviderId}</FieldError>
              )}
            </Field>

            <Field data-invalid={!!validationErrors.memoryExtractionProviderId}>
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
                    memoryExtractionProviderId: value === "none" ? null : value,
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

            <Field data-invalid={!!validationErrors.memoryEmbeddingProviderId}>
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
                    memoryEmbeddingProviderId: value === "none" ? null : value,
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
                semantic memory search. Set an embedding model ID on a provider
                to see it here.
              </FieldDescription>
              {validationErrors.memoryEmbeddingProviderId && (
                <FieldError>
                  {validationErrors.memoryEmbeddingProviderId}
                </FieldError>
              )}
            </Field>

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

            {/* Delegation flags (ADR-0006) — admin-only. When off, only org
              admins may configure the respective resource; when on, the
              workspace owner may self-manage it. */}
            {canManageDelegation && (
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
