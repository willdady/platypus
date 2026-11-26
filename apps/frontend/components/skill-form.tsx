"use client";

import { FieldGroup, FieldSet, FieldDescription } from "@/components/ui/field";
import { FormTextField } from "@/components/form-text-field";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { FormSwitchField } from "@/components/form-switch-field";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailFormState } from "@/components/detail-form-state";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import {
  FieldSkeleton,
  FooterSkeleton,
  FormSkeletonGroup,
  FormSkeletonSet,
  SwitchCardSkeleton,
  SwitchRowSkeleton,
  TextareaSkeleton,
} from "@/components/form-skeleton";
import { useState } from "react";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useRouter } from "next/navigation";
import {
  SKILL_ARGUMENT_HINT_MAX_LENGTH,
  SKILL_BODY_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
  type Skill,
  type SkillResponse,
  type Agent,
} from "@platypus/schemas";
import { useScopedList } from "@/hooks/use-scoped-list";
import { AgentAvatar } from "@/components/agent-avatar";
import { toastGuidanceOrError } from "@/lib/apply-write-outcome";
import { orgRoutes, workspaceRoutes } from "@/lib/routes";
import { SkillBundleCard } from "@/components/skill-bundle";
import type { Serialized } from "@/lib/api-write";
import { toggleInList } from "@/lib/toggle-in-list";

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

function toForm(skill: Serialized<Skill>) {
  return {
    name: skill.name,
    description: skill.description,
    body: skill.body,
    argumentHint: skill.argumentHint ?? "",
    disableModelInvocation: skill.disableModelInvocation,
  };
}

function SkillFormSkeleton({
  className,
  editing,
  agents,
}: {
  className?: string;
  editing: boolean;
  agents: boolean;
}) {
  return (
    <div className={className}>
      <FormSkeletonSet>
        <FormSkeletonGroup className="gap-4">
          <FieldSkeleton counter />
          <TextareaSkeleton counter />
          <TextareaSkeleton heightClassName="h-[200px]" counter />
          <FieldSkeleton description={1} counter />
          <SwitchRowSkeleton />
        </FormSkeletonGroup>
      </FormSkeletonSet>
      {agents && <SwitchCardSkeleton className="mb-6" rows={2} description />}
      <FooterSkeleton buttons={editing ? 2 : 1} />
    </div>
  );
}

function SkillForm({
  classNames,
  orgId,
  workspaceId,
  skillId,
}: {
  classNames?: string;
  orgId: string;
  workspaceId?: string;
  skillId?: string;
}) {
  const returnPath = workspaceId
    ? workspaceRoutes(orgId, workspaceId).root
    : orgRoutes(orgId).settings.skills;
  const scope = workspaceId ? { orgId, workspaceId } : { orgId };

  const { results: agents, isLoading: agentsLoading } = useScopedList<Agent>(
    "agents",
    workspaceId ? scope : null,
  );

  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);

  const router = useRouter();

  const {
    record,
    mutateRecord,
    loadState,
    formData,
    setFormData,
    seedFormData,
    validationErrors,
    isSubmitting,
    canSubmit,
    handleChange,
    toFieldChange,
    submit,
  } = useEntityForm<typeof INITIAL_DATA, unknown, SkillResponse>({
    initialData: INITIAL_DATA,
    entity: "skills",
    scope,
    id: skillId,
    fromRecord: toForm,
    sideState: selectedAgentIds,
    onSeed: (skill) => {
      if (skill.agentIds) setSelectedAgentIds(skill.agentIds);
    },
    retractableFields: RETRACTABLE_FIELDS,
    transformField: (id, value) =>
      id === "name" ? value.toLowerCase() : value,
    buildPayload: (data) => ({
      name: data.name,
      description: data.description,
      body: data.body,
      argumentHint: data.argumentHint || null,
      disableModelInvocation: data.disableModelInvocation,
      ...(workspaceId ? { agentIds: selectedAgentIds } : {}),
    }),
    successMessage: () => (skillId ? "Skill updated" : "Skill created"),
    onSuccess: () => router.push(returnPath),
    onError: toastGuidanceOrError,
  });

  const { dialogProps, openDeleteDialog } = useEntityDelete({
    entity: "skills",
    scope,
    id: skillId,
    successMessage: "Skill deleted",
    onSuccess: () => router.push(returnPath),
    guidanceOnForbidden: true,
  });

  const savedAgentIds = record?.agentIds ?? [];
  const agentsDirty =
    savedAgentIds.length !== selectedAgentIds.length ||
    savedAgentIds.some((id) => !selectedAgentIds.includes(id));

  const form = (
    <form
      noValidate
      className={classNames}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
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
            initialFocus
            trailing={
              <p className="text-xs text-muted-foreground">
                {formData.name.length}/{SKILL_NAME_MAX_LENGTH}
              </p>
            }
          />
          <ExpandableTextarea
            id="description"
            label="Description"
            placeholder="A brief description of what this skill does..."
            value={formData.description}
            onChange={handleChange}
            disabled={isSubmitting}
            maxLength={SKILL_DESCRIPTION_MAX_LENGTH}
            error={validationErrors.description}
          />
          <ExpandableTextarea
            id="body"
            label="Body"
            placeholder="Instructions for this skill..."
            value={formData.body}
            onChange={handleChange}
            disabled={isSubmitting}
            className="min-h-[200px] !font-mono"
            maxLength={SKILL_BODY_MAX_LENGTH}
            error={validationErrors.body}
          />
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
          <FormSwitchField
            name="disableModelInvocation"
            label="User-invocable only"
            description="Keep this Skill out of the model catalogue. People can still invoke it directly."
            checked={formData.disableModelInvocation}
            onCheckedChange={(checked) =>
              setFormData((previous) => ({
                ...previous,
                disableModelInvocation: checked,
              }))
            }
            disabled={isSubmitting}
          />
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
                <FormSwitchField
                  key={agent.id}
                  name={`agent-${agent.id}`}
                  label={agent.name}
                  description={agent.description || "No description"}
                  leading={<AgentAvatar agent={agent} className="size-6" />}
                  checked={selectedAgentIds.includes(agent.id)}
                  onCheckedChange={(checked) =>
                    setSelectedAgentIds((prev) =>
                      toggleInList(prev, agent.id, checked),
                    )
                  }
                  disabled={isSubmitting}
                />
              ))}
            </FieldGroup>
          </CardContent>
        </Card>
      )}

      {record && (
        <SkillBundleCard
          scope={scope}
          skill={record}
          onReplaced={(replaced) => {
            // why: a bundle replace rewrites the fields, so the form re-seeds
            seedFormData(toForm(replaced));
            void mutateRecord();
          }}
        />
      )}

      <FormFooterButtons
        type="submit"
        submitText={skillId ? "Update" : "Save"}
        pending={isSubmitting}
        submitDisabled={isSubmitting || !canSubmit}
        deleteVisible={!!skillId}
        deleteDisabled={isSubmitting || agentsDirty}
        onDelete={openDeleteDialog}
      />
      {skillId && agentsDirty && (
        <p className="mt-2 text-sm text-muted-foreground">
          This skill has unsaved agent changes. Update first.
        </p>
      )}

      <DeleteConfirmDialog noun="skill" {...dialogProps} />
    </form>
  );

  return (
    <DetailFormState
      {...loadState}
      // why: hold the Agents card back with the record, so it never pops in after
      isLoading={agentsLoading || loadState.isLoading}
      subject="skill"
      skeleton={
        <SkillFormSkeleton
          className={classNames}
          editing={!!skillId}
          agents={!!workspaceId}
        />
      }
      backHref={returnPath}
      backLabel={workspaceId ? "Back to workspace" : "Back to skills"}
    >
      {form}
    </DetailFormState>
  );
}

export { SkillForm };
