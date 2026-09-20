"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldDescription,
} from "@/components/ui/field";
import { FormTextField } from "@/components/form-text-field";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { EntityDeleteDialog } from "@/components/entity-delete-dialog";
import { DetailFormState } from "@/components/detail-form-state";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import { useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useRouter } from "next/navigation";
import {
  SKILL_ARGUMENT_HINT_MAX_LENGTH,
  SKILL_BODY_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
  type Skill,
  type Agent,
} from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { toast } from "sonner";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { AgentAvatar } from "@/components/agent-avatar";
import { toastGuidanceOrError } from "@/lib/apply-write-outcome";
import { orgRoutes, workspaceRoutes } from "@/lib/routes";

const RETRACTABLE_FIELDS = [
  "name",
  "description",
  "body",
  "argumentHint",
] as const;

const INITIAL_DATA = {
  name: "",
  description: "",
  body: "",
  argumentHint: "",
  disableModelInvocation: false,
};

const SkillForm = ({
  classNames,
  orgId,
  workspaceId,
  skillId,
}: {
  classNames?: string;
  orgId: string;
  // Absent on the Organization settings surface, where the form manages an
  // org-scoped Shared Skill (ADR-0007).
  workspaceId?: string;
  skillId?: string;
}) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  // The scope determines the backend collection and where we return after save.
  const collectionUrl = workspaceId
    ? `/organizations/${orgId}/workspaces/${workspaceId}/skills`
    : `/organizations/${orgId}/skills`;
  const returnPath = workspaceId
    ? workspaceRoutes(orgId, workspaceId).root
    : orgRoutes(orgId).settings.skills;
  const scope = workspaceId ? { orgId, workspaceId } : { orgId };

  // Fetch existing skill data if editing (includes agentIds in workspace mode)
  const {
    data: skill,
    error: skillError,
    isLoading: skillLoading,
  } = useSWR<Skill & { agentIds?: string[] }>(
    skillId && user ? joinUrl(backendUrl, `${collectionUrl}/${skillId}`) : null,
    fetcher,
  );

  // Agent associations are a workspace concern; only fetched on that surface.
  const { data: agentsData } = useSWR<{ results: Agent[] }>(
    backendUrl && user && workspaceId
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/agents`,
        )
      : null,
    fetcher,
  );
  const agents = agentsData?.results || [];

  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);

  const router = useRouter();

  const {
    formData,
    setFormData,
    validationErrors,
    isSubmitting,
    canSubmit,
    handleChange,
    toFieldChange,
    submit,
  } = useEntityForm<typeof INITIAL_DATA, unknown>({
    initialData: INITIAL_DATA,
    entity: "skills",
    scope,
    id: skillId,
    retractableFields: RETRACTABLE_FIELDS,
    // A Skill name is normalised to lowercase as it is typed.
    transformField: (id, value) =>
      id === "name" ? value.toLowerCase() : value,
    buildPayload: (data) => ({
      name: data.name,
      description: data.description,
      body: data.body,
      argumentHint: data.argumentHint || null,
      disableModelInvocation: data.disableModelInvocation,
      // Scope and agent associations only apply to the workspace surface.
      ...(workspaceId
        ? { workspaceId, agentIds: selectedAgentIds }
        : { organizationId: orgId }),
    }),
    onSuccess: () => router.push(returnPath),
    onError: toastGuidanceOrError,
  });

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    deleteError,
    openDeleteDialog,
    handleDelete,
  } = useEntityDelete({
    entity: "skills",
    scope,
    id: skillId,
    onSuccess: () => router.push(returnPath),
    onError: (message, outcome, { close, setError, stopLoading }) => {
      if (outcome.outcome === "forbidden") {
        // Guidance, not a failure — the backend's message already says
        // where the Shared resource is actually managed (#570).
        toast.info(message);
        close();
      } else {
        setError(message);
        stopLoading();
      }
    },
  });

  // Initialize form with existing skill data when editing
  useResetOnChange(skill, () => {
    if (skill) {
      setFormData({
        name: skill.name,
        description: skill.description,
        body: skill.body,
        argumentHint: skill.argumentHint ?? "",
        disableModelInvocation: skill.disableModelInvocation,
      });
    }
  });

  // Initialize agent selections from the skill's agentIds
  useResetOnChange(skill, () => {
    if (skill?.agentIds) {
      setSelectedAgentIds(skill.agentIds);
    }
  });

  const form = (
    <div className={classNames}>
      <FieldSet className="mb-6">
        <FieldGroup className="gap-4">
          <FormTextField
            label="Name"
            name="name"
            placeholder="skill-name"
            value={formData.name}
            onChange={toFieldChange("name")}
            disabled={isSubmitting}
            error={validationErrors.name}
            autoFocus
            trailing={
              <p className="text-xs text-muted-foreground">
                {formData.name.length}/{SKILL_NAME_MAX_LENGTH}
              </p>
            }
          />
          <Field data-invalid={!!validationErrors.description}>
            <ExpandableTextarea
              id="description"
              label="Description"
              placeholder="A brief description of what this skill does..."
              value={formData.description}
              onChange={handleChange}
              disabled={isSubmitting}
              maxLength={SKILL_DESCRIPTION_MAX_LENGTH}
              aria-invalid={!!validationErrors.description}
              error={validationErrors.description}
            />
          </Field>
          <Field data-invalid={!!validationErrors.body}>
            <ExpandableTextarea
              id="body"
              label="Body"
              placeholder="Instructions for this skill..."
              value={formData.body}
              onChange={handleChange}
              disabled={isSubmitting}
              className="min-h-[200px] !font-mono"
              aria-invalid={!!validationErrors.body}
              maxLength={SKILL_BODY_MAX_LENGTH}
              error={validationErrors.body}
            />
          </Field>
          <FormTextField
            label="Argument hint"
            name="argumentHint"
            value={formData.argumentHint}
            onChange={toFieldChange("argumentHint")}
            disabled={isSubmitting}
            error={validationErrors.argumentHint}
            description="Text shown after the command name when a person invokes this Skill."
            placeholder="What should follow the command?"
            maxLength={SKILL_ARGUMENT_HINT_MAX_LENGTH}
            trailing={
              <p className="text-xs text-muted-foreground">
                {formData.argumentHint.length}/{SKILL_ARGUMENT_HINT_MAX_LENGTH}
              </p>
            }
          />
          <Field orientation="horizontal" className="items-start">
            <Switch
              id="disableModelInvocation"
              checked={formData.disableModelInvocation}
              onCheckedChange={(checked) =>
                setFormData((previous) => ({
                  ...previous,
                  disableModelInvocation: checked,
                }))
              }
              disabled={isSubmitting}
            />
            <div className="space-y-1">
              <FieldLabel htmlFor="disableModelInvocation">
                User-invocable only
              </FieldLabel>
              <FieldDescription>
                Keep this Skill out of the model catalogue. People can still
                invoke it directly.
              </FieldDescription>
            </div>
          </Field>
        </FieldGroup>
      </FieldSet>

      {agents.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Agents</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldDescription className="mb-4">
              Select which agents this skill is enabled for.
            </FieldDescription>
            <FieldGroup className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {agents.map((agent) => (
                <Field key={agent.id} orientation="horizontal">
                  <Switch
                    id={`agent-${agent.id}`}
                    className="cursor-pointer"
                    checked={selectedAgentIds.includes(agent.id)}
                    onCheckedChange={(checked) => {
                      setSelectedAgentIds((prev) =>
                        checked
                          ? [...prev, agent.id]
                          : prev.filter((id) => id !== agent.id),
                      );
                    }}
                    disabled={isSubmitting}
                  />
                  <FieldLabel htmlFor={`agent-${agent.id}`}>
                    <div className="flex items-center gap-2">
                      <AgentAvatar agent={agent} className="size-6" />
                      <div className="flex flex-col">
                        <p>{agent.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {agent.description || "No description"}
                        </p>
                      </div>
                    </div>
                  </FieldLabel>
                </Field>
              ))}
            </FieldGroup>
          </CardContent>
        </Card>
      )}

      <FormFooterButtons
        submitText={skillId ? "Update" : "Save"}
        onSubmit={() => void submit()}
        submitDisabled={isSubmitting || !canSubmit}
        deleteVisible={!!skillId}
        deleteDisabled={isSubmitting}
        onDelete={openDeleteDialog}
      />

      <EntityDeleteDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete Skill"
        description="Are you sure you want to delete this skill? This action cannot be undone."
        onConfirm={handleDelete}
        loading={isDeleting}
        error={deleteError}
      />
    </div>
  );

  return (
    <DetailFormState
      isLoading={skillLoading}
      error={skillError}
      data={skill}
      subject="skill"
      backHref={returnPath}
      backLabel={workspaceId ? "Back to workspace" : "Back to skills"}
    >
      {form}
    </DetailFormState>
  );
};

export { SkillForm };
