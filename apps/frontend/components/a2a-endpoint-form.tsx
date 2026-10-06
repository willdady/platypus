"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  A2A_ENDPOINT_DESCRIPTION_MAX_LENGTH,
  A2A_ENDPOINT_NAME_MAX_LENGTH,
  type A2aEndpoint,
  type A2aToken,
  type Agent,
} from "@platypus/schemas";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { SelectItem } from "@/components/ui/select";
import { FormTextField } from "@/components/form-text-field";
import { FormTextareaField } from "@/components/form-textarea-field";
import { FormSelectField } from "@/components/form-select-field";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import { DetailFormState } from "@/components/detail-form-state";
import { EntityDeleteDialog } from "@/components/entity-delete-dialog";
import { AgentAvatar } from "@/components/agent-avatar";
import { A2aEndpointNotices } from "@/components/a2a-endpoint-notices";
import { A2aTokens, ACCESS_SECTION_ID } from "@/components/a2a-tokens";
import { useAuth } from "@/components/auth-provider";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { workspaceRoutes } from "@/lib/routes";

type Endpoint = A2aEndpoint & { tokens: A2aToken[] };

const INITIAL_DATA = {
  agentId: "",
  name: "",
  description: "",
  enabled: true,
  includeMemories: false,
  extractMemories: false,
};

/**
 * Creates or edits an A2A endpoint (ADR-0032), and on an existing one shows
 * its card URL and manages its tokens. Only the Workspace Owner edits; an Org
 * Admin sees it read-only.
 */
const A2aEndpointForm = ({
  orgId,
  workspaceId,
  endpointId,
}: {
  orgId: string;
  workspaceId: string;
  endpointId?: string;
}) => {
  const router = useRouter();
  const { ownsWorkspace } = useAuth();
  const scope = { orgId, workspaceId };
  const routes = workspaceRoutes(orgId, workspaceId).settings;
  const isEditMode = !!endpointId;
  const readOnly = !ownsWorkspace;

  const { data: agentsData } = useScopedSWR<{ results: Agent[] }>(
    "agents",
    scope,
  );
  const agents = agentsData?.results ?? [];

  const {
    record: endpoint,
    mutateRecord,
    loadState,
    formData,
    setField,
    validationErrors,
    isSubmitting,
    canSubmit,
    toFieldChange,
    submit,
  } = useEntityForm<typeof INITIAL_DATA, A2aEndpoint, Endpoint>({
    initialData: INITIAL_DATA,
    entity: "a2a-endpoints",
    scope,
    id: endpointId,
    fromRecord: (record) => ({
      agentId: record.agentId,
      name: record.name,
      description: record.description,
      enabled: record.enabled,
      includeMemories: record.includeMemories,
      extractMemories: record.extractMemories,
    }),
    retractableFields: ["agentId", "name", "description", "enabled"],
    // On create, a blank name or description is left for the backend to copy
    // from the Agent; the Agent can't change once the endpoint exists.
    buildPayload: (data) =>
      isEditMode
        ? {
            name: data.name,
            description: data.description,
            enabled: data.enabled,
            includeMemories: data.includeMemories,
            extractMemories: data.extractMemories,
          }
        : {
            agentId: data.agentId,
            enabled: data.enabled,
            includeMemories: data.includeMemories,
            extractMemories: data.extractMemories,
            ...(data.name.trim() ? { name: data.name } : {}),
            ...(data.description.trim()
              ? { description: data.description }
              : {}),
          },
    successMessage: () =>
      isEditMode ? "A2A endpoint updated" : "A2A endpoint created",
    // A new endpoint lands on its own page, scrolled to where its tokens
    // are issued.
    onSuccess: (saved) =>
      router.push(
        isEditMode
          ? routes.a2aEndpoints
          : `${routes.a2aEndpointDetail(saved.id)}#${ACCESS_SECTION_ID}`,
      ),
  });

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    openDeleteDialog,
    handleDelete,
  } = useEntityDelete({
    entity: "a2a-endpoints",
    scope,
    id: endpointId,
    successMessage: "A2A endpoint deleted",
    onSuccess: () => router.push(routes.a2aEndpoints),
    onError: (message, _outcome, { close }) => {
      toast.error(message);
      close();
    },
  });

  // Picking an Agent fills the name and description, unless the Owner has
  // typed their own over what the previous pick filled in.
  const selectAgent = (agentId: string) => {
    const previous = agents.find((a) => a.id === formData.agentId);
    const next = agents.find((a) => a.id === agentId);
    setField("agentId", agentId);
    if (!next) return;
    for (const field of ["name", "description"] as const) {
      const current = formData[field];
      if (!current.trim() || current === previous?.[field])
        setField(field, next[field]);
    }
  };

  const form = (
    <div>
      <A2aEndpointNotices orgId={orgId} workspaceId={workspaceId} />

      <FieldSet className="mb-6">
        <FieldGroup>
          <FormSelectField
            label="Agent"
            name="agentId"
            value={formData.agentId}
            onValueChange={selectAgent}
            disabled={isSubmitting || isEditMode || readOnly}
            placeholder="Select an agent"
            error={validationErrors.agentId}
            description={
              isEditMode
                ? "An endpoint stays with the agent it was made for."
                : "The agent outside callers talk to."
            }
          >
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                <AgentAvatar agent={agent} className="size-5" />
                {agent.name}
              </SelectItem>
            ))}
          </FormSelectField>

          <FormTextField
            label="Name"
            name="name"
            value={formData.name}
            onChange={toFieldChange("name")}
            disabled={isSubmitting || readOnly}
            error={validationErrors.name}
            maxLength={A2A_ENDPOINT_NAME_MAX_LENGTH}
            placeholder={isEditMode ? undefined : "The agent's name"}
            description="Shown to outside callers on the agent card."
          />

          <FormTextareaField
            label="Description"
            name="description"
            value={formData.description}
            onChange={toFieldChange("description")}
            disabled={isSubmitting || readOnly}
            error={validationErrors.description}
            maxLength={A2A_ENDPOINT_DESCRIPTION_MAX_LENGTH}
            placeholder={isEditMode ? undefined : "The agent's description"}
            description="Shown to outside callers on the agent card, in place of the agent's own description."
          />

          <Field>
            <div className="flex items-center gap-3">
              <Switch
                id="enabled"
                checked={formData.enabled}
                onCheckedChange={(checked) => setField("enabled", checked)}
                disabled={isSubmitting || readOnly}
              />
              <FieldLabel htmlFor="enabled" className="mb-0">
                Enabled
              </FieldLabel>
            </div>
            <FieldDescription>
              When disabled, the endpoint answers every call with Not Found.
            </FieldDescription>
          </Field>

          {/* Both off by default: whoever holds a token may not be you. */}
          <Field orientation="horizontal">
            <Switch
              id="includeMemories"
              className="cursor-pointer"
              checked={formData.includeMemories}
              onCheckedChange={(checked) =>
                setField("includeMemories", checked)
              }
              disabled={isSubmitting || readOnly}
            />
            <FieldLabel htmlFor="includeMemories">
              <div className="flex flex-col">
                <p>Include Memories</p>
                <p className="text-xs text-muted-foreground">
                  Add your recent memory summaries to the agent&apos;s system
                  prompt on this endpoint&apos;s runs. Leave off if anyone other
                  than you holds a token.
                </p>
              </div>
            </FieldLabel>
          </Field>

          <Field orientation="horizontal">
            <Switch
              id="extractMemories"
              className="cursor-pointer"
              checked={formData.extractMemories}
              onCheckedChange={(checked) =>
                setField("extractMemories", checked)
              }
              disabled={isSubmitting || readOnly}
            />
            <FieldLabel htmlFor="extractMemories">
              <div className="flex flex-col">
                <p>Extract Memories</p>
                <p className="text-xs text-muted-foreground">
                  Let this endpoint&apos;s chats feed your memories, including
                  turns you add to them yourself. Leave off if anyone other than
                  you holds a token.
                </p>
              </div>
            </FieldLabel>
          </Field>

          {endpoint && (
            <A2aTokens
              orgId={orgId}
              endpoint={endpoint}
              mutate={mutateRecord}
            />
          )}
        </FieldGroup>
      </FieldSet>

      {!readOnly && (
        <FormFooterButtons
          submitText={isEditMode ? "Update" : "Save"}
          onSubmit={() => void submit()}
          submitDisabled={isSubmitting || !canSubmit || !formData.agentId}
          deleteVisible={isEditMode}
          deleteDisabled={isSubmitting}
          onDelete={openDeleteDialog}
        />
      )}

      <EntityDeleteDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete A2A endpoint"
        description="Its URL and every one of its tokens stop working straight away."
        onConfirm={handleDelete}
        loading={isDeleting}
      />
    </div>
  );

  return (
    <DetailFormState
      {...loadState}
      subject="A2A endpoint"
      backHref={routes.a2aEndpoints}
      backLabel="Back to A2A endpoints"
    >
      {form}
    </DetailFormState>
  );
};

export { A2aEndpointForm };
