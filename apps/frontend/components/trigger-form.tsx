"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldDescription,
} from "@/components/ui/field";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { FormTextField } from "@/components/form-text-field";
import { FormSelectField } from "@/components/form-select-field";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { EntityDeleteDialog } from "@/components/entity-delete-dialog";
import { DetailFormState } from "@/components/detail-form-state";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import {
  CollapsibleSkeleton,
  FieldSkeleton,
  FooterSkeleton,
  FormSkeletonGroup,
  FormSkeletonSet,
  SwitchRowSkeleton,
  TextareaSkeleton,
} from "@/components/form-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useState, useMemo } from "react";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, ShieldOff } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TriggerCronFields } from "@/components/trigger-cron-fields";
import {
  TriggerEventFields,
  useEventFilterListsLoading,
} from "@/components/trigger-event-fields";
import { TriggerInboundFields } from "@/components/trigger-inbound-fields";
import {
  type Trigger,
  type Agent,
  type Organization,
  type TriggerType,
  type Workspace,
} from "@platypus/schemas";
import {
  gateAdmits,
  TRIGGER_INSTRUCTION_MAX_LENGTH,
  TRIGGER_MAX_RUNS_TO_KEEP_MAX,
  TRIGGER_MAX_RUNS_TO_KEEP_MIN,
} from "@platypus/schemas";
import type { FormErrors } from "@/lib/form-errors";
import { workspaceRoutes } from "@/lib/routes";
import { organizationEntity, workspaceEntity } from "@/lib/api-write";
import { TRIGGER_TYPE_LABELS } from "@/components/trigger-list";

const INSTRUCTION_PLACEHOLDERS: Record<TriggerType, string> = {
  cron: "Generate a daily report of...",
  event: "Process the incoming event and...",
  inbound: "Work on the issue named in issueKey and...",
};

const INSTRUCTION_DESCRIPTIONS: Record<TriggerType, string> = {
  cron: "The message sent to the agent each time this trigger runs",
  event:
    "The message sent to the agent when the event occurs. Event data is included automatically.",
  inbound:
    "The message sent to the agent on each call. The call's inputs appear above it with their descriptions, so refer to them by name.",
};

/** What a save answers: a new Inbound Trigger's carries its token, once. */
export type SavedTrigger = {
  id: string;
  token?: string;
  tokenExpiresAt?: string | null;
};

/** What a trigger type's fields contribute to the save. */
export type TriggerTypeFields = {
  type: TriggerType;
  /** The payload's `config`. */
  config: unknown;
  /** Whether the fields let the trigger save. */
  valid: boolean;
  /**
   * Takes over once the save lands, e.g. to show a new token before leaving.
   * Returns true when it did, so the form doesn't navigate away itself.
   */
  onSaved?: (saved: SavedTrigger) => boolean;
};

/** The props every trigger type's fields component takes. */
export type TriggerFieldsProps = {
  /** The saved trigger being edited; absent when creating. */
  trigger?: Trigger;
  scope: { orgId: string; workspaceId: string };
  disabled: boolean;
  errors: FormErrors;
  clearErrors: (...ids: string[]) => void;
  /** Called with the fields' slice of the save whenever it changes. */
  onChange: (fields: TriggerTypeFields) => void;
  /** Revalidates the saved trigger. */
  mutateRecord: () => Promise<unknown>;
};

const TRIGGER_TYPE_FIELDS = {
  cron: TriggerCronFields,
  event: TriggerEventFields,
  inbound: TriggerInboundFields,
} satisfies Record<TriggerType, React.ComponentType<TriggerFieldsProps>>;

// isOneOff, maxRunsToKeep, search, includeMemories,
// filterBoardId/filterColumnId, and enabled are deliberately excluded: this
// form has no field that retracts an error keyed to them.
const RETRACTABLE_FIELDS = [
  "name",
  "description",
  "agentId",
  "instruction",
  "cronExpression",
  "timezone",
  "config",
] as const;

type TriggerFormData = {
  name: string;
  description: string;
  agentId: string;
  instruction: string;
  enabled: boolean;
  maxRunsToKeep: number;
  search: boolean;
  includeMemories: boolean;
};

/** The cron layout, which a new trigger opens on and most saved ones use. */
const TriggerFormSkeleton = ({ editing }: { editing: boolean }) => (
  <div>
    <FormSkeletonSet>
      <FormSkeletonGroup>
        <FieldSkeleton />
        <FieldSkeleton />
        <FieldSkeleton />
        <FieldSkeleton />
        <TextareaSkeleton counter description={1} />
        {/* Schedule Mode's button pair */}
        <div className="flex w-full flex-col gap-3">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-9 w-44" />
        </div>
        <FieldSkeleton />
        <div className="flex gap-4">
          <FieldSkeleton className="flex-1" />
          <FieldSkeleton className="flex-1" />
        </div>
        <FieldSkeleton />
        <SwitchRowSkeleton />
        <FieldSkeleton className="w-1/2" description={1} />
        <SwitchRowSkeleton />
        <SwitchRowSkeleton />
        <CollapsibleSkeleton />
      </FormSkeletonGroup>
    </FormSkeletonSet>
    <FooterSkeleton buttons={editing ? 2 : 1} />
  </div>
);

const TriggerForm = ({
  orgId,
  workspaceId,
  triggerId,
}: {
  orgId: string;
  workspaceId: string;
  triggerId?: string;
}) => {
  const scope = { orgId, workspaceId };

  const { data: agentsData, isLoading: agentsLoading } = useScopedSWR<{
    results: Agent[];
  }>("agents", scope);
  const agents = useMemo(() => agentsData?.results || [], [agentsData]);
  // A new Trigger runs on the first agent until the user picks another.
  // Derived rather than written into the form, so a revalidated agent list
  // can never overwrite the user's pick.
  const defaultAgentId = triggerId ? "" : (agents[0]?.id ?? "");

  const [triggerType, setTriggerType] = useState<TriggerType>("cron");
  // The selected type's slice of the save, as its fields last reported it.
  const [typeFields, setTypeFields] = useState<TriggerTypeFields | null>(null);

  // Whether the Organization gate lets this Workspace take calls, so an Owner
  // is told before they wire up a caller that would only ever get 404.
  const { data: organization } = useScopedSWR<Organization>(
    organizationEntity(orgId),
    {},
  );
  const { data: workspace } = useScopedSWR<Workspace>(
    workspaceEntity(workspaceId),
    { orgId },
  );

  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);

  const router = useRouter();

  const {
    record: trigger,
    mutateRecord,
    loadState,
    formData,
    setFormData,
    validationErrors,
    isSubmitting,
    canSubmit,
    handleChange,
    toFieldChange,
    setNumberField,
    setField,
    clearErrors,
    submit,
  } = useEntityForm<TriggerFormData, SavedTrigger, Trigger>({
    initialData: {
      name: "",
      description: "",
      agentId: "",
      instruction: "",
      enabled: true,
      maxRunsToKeep: 10,
      search: false,
      includeMemories: false,
    },
    entity: "triggers",
    scope: { orgId, workspaceId },
    id: triggerId,
    fromRecord: (trigger) => ({
      name: trigger.name,
      description: trigger.description || "",
      agentId: trigger.agentId,
      instruction: trigger.instruction,
      enabled: trigger.enabled,
      maxRunsToKeep: trigger.maxRunsToKeep,
      search: trigger.search ?? false,
      includeMemories: trigger.includeMemories ?? false,
    }),
    onSeed: (trigger) => setTriggerType(trigger.type),
    retractableFields: RETRACTABLE_FIELDS,
    buildPayload: (data): unknown => ({
      workspaceId,
      agentId: data.agentId || defaultAgentId,
      name: data.name,
      description: data.description || undefined,
      instruction: data.instruction,
      enabled: data.enabled,
      maxRunsToKeep: data.maxRunsToKeep,
      search: data.search,
      includeMemories: data.includeMemories,
      type: triggerType,
      config: typeFields?.config,
    }),
    onSuccess: (saved) => {
      if (typeFields?.onSaved?.(saved)) return;
      router.push(workspaceRoutes(orgId, workspaceId).root);
    },
    failureMessage: "Error saving trigger",
  });

  const filterListsLoading = useEventFilterListsLoading(trigger, scope);

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    deleteError,
    openDeleteDialog,
    handleDelete,
  } = useEntityDelete({
    entity: "triggers",
    scope: { orgId, workspaceId },
    id: triggerId,
    onSuccess: () => router.push(workspaceRoutes(orgId, workspaceId).root),
  });

  // Until the selected type's fields report, there is nothing to save.
  const typeFieldsValid = typeFields?.type === triggerType && typeFields.valid;

  // A fired One-off can be renamed or deleted, never re-armed.
  const scheduleLocked = isSubmitting || !!trigger?.firedAt;
  // Only once everything the answer depends on has loaded: under `selected`
  // that includes the Workspace's own flag, and a Workspace still loading (or
  // failed to load) is unknown, not disallowed.
  const gateClosed =
    organization !== undefined &&
    (organization.inboundTriggerGate !== "selected" ||
      workspace !== undefined) &&
    !gateAdmits(
      organization.inboundTriggerGate,
      workspace?.inboundTriggersAllowed,
    );

  const inboundBlocked = triggerType === "inbound" && gateClosed;

  const TypeFields = TRIGGER_TYPE_FIELDS[triggerType];

  const form = (
    <div>
      <FieldSet className="mb-6">
        <FieldGroup>
          {/* Trigger Type Selector */}
          <Field>
            <FieldLabel htmlFor="trigger-type">Trigger Type</FieldLabel>
            <Select
              value={triggerType}
              onValueChange={(value) => setTriggerType(value as TriggerType)}
              disabled={isSubmitting || !!triggerId}
            >
              <SelectTrigger
                id="trigger-type"
                disabled={isSubmitting || !!triggerId}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(TRIGGER_TYPE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {inboundBlocked && (
            <Alert>
              <ShieldOff />
              <AlertTitle>Inbound Triggers not allowed</AlertTitle>
              <AlertDescription>
                Your Organization doesn&apos;t allow Inbound Triggers in this
                Workspace.
              </AlertDescription>
            </Alert>
          )}

          {!inboundBlocked && (
            <>
              <FormTextField
                label="Name"
                name="name"
                placeholder="Daily report generation"
                value={formData.name}
                onChange={toFieldChange("name")}
                disabled={isSubmitting}
                error={validationErrors.name}
                autoFocus
              />

              <FormTextField
                label="Description"
                name="description"
                placeholder="Optional description..."
                value={formData.description}
                onChange={toFieldChange("description")}
                disabled={isSubmitting}
                error={validationErrors.description}
              />

              <FormSelectField
                label="Agent"
                name="agentId"
                value={formData.agentId || defaultAgentId}
                onValueChange={(value) => setField("agentId", value)}
                disabled={isSubmitting}
                placeholder="Select an agent"
                error={validationErrors.agentId}
              >
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    <AgentAvatar agent={agent} className="size-5" />
                    {agent.name}
                  </SelectItem>
                ))}
              </FormSelectField>

              <Field data-invalid={!!validationErrors.instruction}>
                <ExpandableTextarea
                  id="instruction"
                  label="Instruction"
                  placeholder={INSTRUCTION_PLACEHOLDERS[triggerType]}
                  value={formData.instruction}
                  onChange={handleChange}
                  disabled={isSubmitting}
                  maxLength={TRIGGER_INSTRUCTION_MAX_LENGTH}
                  aria-invalid={!!validationErrors.instruction}
                  error={validationErrors.instruction}
                />
                <FieldDescription>
                  {INSTRUCTION_DESCRIPTIONS[triggerType]}
                </FieldDescription>
              </Field>

              <TypeFields
                trigger={trigger}
                scope={scope}
                disabled={isSubmitting}
                errors={validationErrors}
                clearErrors={clearErrors}
                onChange={setTypeFields}
                mutateRecord={mutateRecord}
              />

              <FormTextField
                className="w-1/2"
                label="Max Runs to Keep"
                name="maxRunsToKeep"
                type="number"
                min={TRIGGER_MAX_RUNS_TO_KEEP_MIN}
                max={TRIGGER_MAX_RUNS_TO_KEEP_MAX}
                value={String(formData.maxRunsToKeep)}
                onChange={(value) => setNumberField("maxRunsToKeep", value)}
                disabled={isSubmitting}
                description="Minimum number of recent run records to keep; older ones are pruned"
              />

              <Field orientation="horizontal">
                <Switch
                  id="search"
                  className="cursor-pointer"
                  checked={formData.search}
                  onCheckedChange={(checked) =>
                    setFormData((prev) => ({ ...prev, search: checked }))
                  }
                  disabled={isSubmitting}
                />
                <FieldLabel
                  htmlFor="search"
                  className="flex-col items-stretch gap-0"
                >
                  <p>Web Search</p>
                  <p className="text-xs text-muted-foreground">
                    Web search on the resolved provider — its built-in tool, or
                    a Web-search backend selected on it
                  </p>
                </FieldLabel>
              </Field>

              <Field orientation="horizontal">
                <Switch
                  id="enabled"
                  className="cursor-pointer"
                  checked={formData.enabled}
                  onCheckedChange={(checked) =>
                    setFormData((prev) => ({ ...prev, enabled: checked }))
                  }
                  disabled={scheduleLocked}
                />
                <FieldLabel
                  htmlFor="enabled"
                  className="flex-col items-stretch gap-0"
                >
                  <p>Enabled</p>
                  <p className="text-xs text-muted-foreground">
                    {triggerType === "inbound"
                      ? "Trigger accepts calls. A disabled one refuses them."
                      : "Trigger will run automatically"}
                  </p>
                </FieldLabel>
              </Field>

              <Collapsible
                open={isAdvancedOpen}
                onOpenChange={setIsAdvancedOpen}
              >
                <CollapsibleTrigger asChild>
                  <div className="flex text-sm justify-between items-center">
                    <span className="cursor-default">Advanced settings</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="cursor-pointer size-8"
                    >
                      <ChevronsUpDown />
                      <span className="sr-only">Toggle</span>
                    </Button>
                  </div>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <Field orientation="horizontal" className="pt-2">
                    <Switch
                      id="includeMemories"
                      className="cursor-pointer"
                      checked={formData.includeMemories}
                      onCheckedChange={(checked) =>
                        setFormData((prev) => ({
                          ...prev,
                          includeMemories: checked,
                        }))
                      }
                      disabled={isSubmitting}
                    />
                    <FieldLabel
                      htmlFor="includeMemories"
                      className="flex-col items-stretch gap-0"
                    >
                      <p>Include Memories</p>
                      <p className="text-xs text-muted-foreground">
                        Add your recent memory summaries to this trigger&apos;s
                        system prompt. Off by default, so a run isn&apos;t
                        influenced by chat activity unrelated to it.
                      </p>
                    </FieldLabel>
                  </Field>
                </CollapsibleContent>
              </Collapsible>
            </>
          )}
        </FieldGroup>
      </FieldSet>

      <FormFooterButtons
        submitText={triggerId ? "Update" : "Save"}
        onSubmit={() => void submit()}
        submitDisabled={
          isSubmitting || !canSubmit || !typeFieldsValid || inboundBlocked
        }
        deleteVisible={!!triggerId}
        deleteDisabled={isSubmitting}
        onDelete={openDeleteDialog}
      />

      <EntityDeleteDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete Trigger"
        description="Are you sure you want to delete this trigger? This will also delete all run history for this trigger. This action cannot be undone."
        onConfirm={handleDelete}
        loading={isDeleting}
        error={deleteError}
      />
    </div>
  );

  return (
    <DetailFormState
      {...loadState}
      isLoading={agentsLoading || filterListsLoading || loadState.isLoading}
      subject="trigger"
      skeleton={<TriggerFormSkeleton editing={!!triggerId} />}
      backHref={workspaceRoutes(orgId, workspaceId).root}
      backLabel="Back to workspace"
    >
      {form}
    </DetailFormState>
  );
};

export { TriggerForm };
