"use client";

import { FieldGroup, FieldSet } from "@/components/ui/field";
import { FormTextField } from "@/components/form-text-field";
import { FormSwitchField } from "@/components/form-switch-field";
import { ProviderPointerSelect } from "@/components/provider-pointer-select";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import { DetailFormState } from "@/components/detail-form-state";
import { hardNavigate } from "@/components/unsaved-changes-guard";
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
  canManageWorkspaceDelegation,
  canTransferWorkspace,
} from "@/lib/authorization";
import { TransferWorkspaceAction } from "@/components/transfer-workspace-dialog";
import { useAuth } from "@/components/auth-provider";
import { useScopedList } from "@/hooks/use-scoped-list";
import Link from "next/link";
import {
  FieldSkeleton,
  FooterSkeleton,
  FormSkeletonGroup,
  FormSkeletonSet,
  SwitchRowSkeleton,
  TextareaSkeleton,
} from "@/components/form-skeleton";
import { orgRoutes, withBasePath, workspaceRoutes } from "@/lib/routes";
import { useOrganization } from "@/hooks/use-organization";

type WorkspaceFormProps = {
  orgId: string;
  workspaceId: string;
};

// providerSelfManagement, mcpSelfManagement and inboundTriggersAllowed are
// deliberately excluded:
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
  inboundTriggersAllowed: boolean;
};

function WorkspaceFormSkeleton({ delegation }: { delegation: boolean }) {
  return (
    <div>
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
              <SwitchRowSkeleton align="end" />
              <SwitchRowSkeleton align="end" />
              <SwitchRowSkeleton align="end" />
            </>
          )}
        </FormSkeletonGroup>
      </FormSkeletonSet>
      <FooterSkeleton buttons={2} />
    </div>
  );
}

function WorkspaceForm({ orgId, workspaceId }: WorkspaceFormProps) {
  const { actor } = useAuth();
  const canManageDelegation = canManageWorkspaceDelegation(actor);
  const canTransfer = canTransferWorkspace(actor);
  const router = useRouter();

  // Fetch providers
  const { results: providers, isLoading: providersLoading } =
    useScopedList<Provider>("providers", { orgId, workspaceId });

  // The Workspace's Inbound Trigger switch only counts under the
  // Organization's "Selected workspaces" gate (ADR-0030).
  const { data: organization } = useOrganization(orgId, {
    enabled: canManageDelegation,
  });
  const inboundGate = organization?.inboundTriggerGate;

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
    setField,
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
      inboundTriggersAllowed: false,
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
      maxDailySummaries: workspace.maxDailySummaries,
      providerSelfManagement: workspace.providerSelfManagement ?? false,
      mcpSelfManagement: workspace.mcpSelfManagement ?? false,
      inboundTriggersAllowed: workspace.inboundTriggersAllowed ?? false,
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
      // Admin-only too; read only while the Organization's Inbound Triggers
      // setting is "Selected workspaces" (ADR-0030).
      inboundTriggersAllowed: data.inboundTriggersAllowed,
    }),
    successMessage: "Workspace updated",
    onSuccess: () => {
      router.refresh();
    },
  });

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    deleteError,
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
      hardNavigate(withBasePath(orgRoutes(orgId).root));
    },
  });

  return (
    <DetailFormState
      {...loadState}
      // The provider selects resolve their values against this list, so
      // they'd render blank or partial without it.
      isLoading={providersLoading || loadState.isLoading}
      subject="workspace"
      skeleton={<WorkspaceFormSkeleton delegation={canManageDelegation} />}
      backHref={workspaceRoutes(orgId, workspaceId).root}
      backLabel="Back to workspace"
    >
      <form
        noValidate
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
              placeholder="Workspace name"
              value={formData.name}
              onChange={toFieldChange("name")}
              disabled={isSubmitting}
              error={validationErrors.name}
              autoFocus
            />

            <ExpandableTextarea
              id="context"
              label="Context"
              placeholder="Optional context for this workspace"
              value={formData.context}
              onChange={handleChange}
              disabled={isSubmitting}
              className="!font-mono"
              maxLength={CONTEXT_MAX_LENGTH}
              error={validationErrors.context}
              description="Additional context about this workspace included in all chats in this workspace"
            />

            <ProviderPointerSelect
              kind="task"
              label="Task Model Provider"
              noneLabel="None (use chat provider)"
              description="Provider to use for generating chat titles. If not set, each chat will use its own provider for metadata generation."
              value={formData.taskModelProviderId}
              onChange={(value) => setField("taskModelProviderId", value)}
              error={validationErrors.taskModelProviderId}
              disabled={isSubmitting}
              providers={providers}
            />

            <ProviderPointerSelect
              kind="memoryExtraction"
              label="Memory Extraction Provider"
              noneLabel="Disabled"
              description="Provider to use for extracting memories from conversations. Enable memory extraction on a provider to see it here."
              value={formData.memoryExtractionProviderId}
              onChange={(value) =>
                setField("memoryExtractionProviderId", value)
              }
              error={validationErrors.memoryExtractionProviderId}
              disabled={isSubmitting}
              providers={providers}
            />

            <ProviderPointerSelect
              kind="embedding"
              label="Memory Embedding Provider"
              noneLabel="Disabled"
              description="Provider to use for generating memory embeddings. Required for semantic memory search. Set an embedding model ID on a provider to see it here."
              value={formData.memoryEmbeddingProviderId}
              onChange={(value) => setField("memoryEmbeddingProviderId", value)}
              error={validationErrors.memoryEmbeddingProviderId}
              disabled={isSubmitting}
              providers={providers}
            />

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
                <FormSwitchField
                  align="end"
                  name="providerSelfManagement"
                  label="Owner-managed providers"
                  description="Let the workspace owner create and edit workspace-scoped providers. Off by default (org admins only)."
                  checked={formData.providerSelfManagement}
                  disabled={isSubmitting}
                  onCheckedChange={(checked) =>
                    setFormData((prev) => ({
                      ...prev,
                      providerSelfManagement: checked,
                    }))
                  }
                />

                <FormSwitchField
                  align="end"
                  name="mcpSelfManagement"
                  label="Owner-managed MCP servers"
                  description="Let the workspace owner register and authorize their own MCP servers (e.g. personal-credential integrations). Off by default (org admins only)."
                  checked={formData.mcpSelfManagement}
                  disabled={isSubmitting}
                  onCheckedChange={(checked) =>
                    setFormData((prev) => ({
                      ...prev,
                      mcpSelfManagement: checked,
                    }))
                  }
                />

                <FormSwitchField
                  align="end"
                  name="inboundTriggersAllowed"
                  label="Allow Inbound Triggers"
                  description={
                    inboundGate === "off" || inboundGate === "all" ? (
                      <>
                        {inboundGate === "all"
                          ? "Your organization allows Inbound Triggers in every workspace."
                          : "Your organization doesn't allow Inbound Triggers."}{" "}
                        Change this in the organization&apos;s{" "}
                        <Link
                          href={orgRoutes(orgId).settings.inboundTriggers}
                          className="underline"
                        >
                          Inbound Triggers
                        </Link>{" "}
                        settings.
                      </>
                    ) : (
                      <>
                        Let this workspace&apos;s Inbound Triggers accept calls
                        from outside Platypus. Off by default.
                      </>
                    )
                  }
                  checked={formData.inboundTriggersAllowed}
                  disabled={isSubmitting || inboundGate !== "selected"}
                  onCheckedChange={(checked) =>
                    setFormData((prev) => ({
                      ...prev,
                      inboundTriggersAllowed: checked,
                    }))
                  }
                />
              </>
            )}
          </FieldGroup>
        </FieldSet>

        <div className="flex flex-wrap items-start gap-2">
          <FormFooterButtons
            type="submit"
            submitText="Save"
            pending={isSubmitting}
            submitDisabled={isSubmitting || !canSubmit}
            deleteVisible
            deleteDisabled={isSubmitting}
            onDelete={openDeleteDialog}
          />
          {canTransfer && (
            <TransferWorkspaceAction
              orgId={orgId}
              workspaceId={workspaceId}
              providers={providers}
            />
          )}
        </div>

        <DeleteConfirmDialog
          open={isDeleteDialogOpen}
          onOpenChange={setIsDeleteDialogOpen}
          noun="workspace"
          requireTypedConfirmation
          onConfirm={handleDelete}
          loading={isDeleting}
          error={deleteError}
        />
      </form>
    </DetailFormState>
  );
}

export { WorkspaceForm };
