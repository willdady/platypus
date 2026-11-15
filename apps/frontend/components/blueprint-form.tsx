"use client";

import { FieldGroup, FieldSet } from "@/components/ui/field";
import { FormTextField } from "@/components/form-text-field";
import { FormSwitchField } from "@/components/form-switch-field";
import { ProviderPointerSelect } from "@/components/provider-pointer-select";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailFormState } from "@/components/detail-form-state";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import { ListError, ListState } from "@/components/list-state";
import { useState } from "react";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useRouter } from "next/navigation";
import { Bot, Sparkles, Unplug, Wrench } from "lucide-react";
import type {
  Blueprint,
  BlueprintItem,
  AttachmentResourceType,
  Provider,
} from "@platypus/schemas";
import {
  BLUEPRINT_DESCRIPTION_MAX_LENGTH,
  BLUEPRINT_NAME_MAX_LENGTH,
  CONTEXT_MAX_LENGTH,
} from "@platypus/schemas";
import { sortByName } from "@/lib/utils";
import { useScopedList } from "@/hooks/use-scoped-list";
import {
  FieldSkeleton,
  FooterSkeleton,
  FormSkeletonGroup,
  FormSkeletonSet,
  SwitchCardSkeleton,
  SwitchGridSkeleton,
  TextareaSkeleton,
} from "@/components/form-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { orgRoutes } from "@/lib/routes";

// The composer lists every Shared resource the org owns, grouped by type. A
// Blueprint may only list org-scoped resources, so these org collections are
// exactly the eligible set (ADR-0008).
const RESOURCE_GROUPS: {
  type: AttachmentResourceType;
  label: string;
  /** The plural noun a failed read names: "MCP servers". */
  subject: string;
  collection: string;
  icon: typeof Bot;
}[] = [
  {
    type: "agent",
    label: "Agents",
    subject: "agents",
    collection: "agents",
    icon: Bot,
  },
  {
    type: "skill",
    label: "Skills",
    subject: "skills",
    collection: "skills",
    icon: Sparkles,
  },
  {
    type: "mcp",
    label: "MCP servers",
    subject: "MCP servers",
    collection: "mcps",
    icon: Wrench,
  },
  {
    type: "provider",
    label: "Providers",
    subject: "providers",
    collection: "providers",
    icon: Unplug,
  },
];

type SharedResource = { id: string; name: string; description?: string };

function itemKey(type: AttachmentResourceType, id: string) {
  return `${type}:${id}`;
}

function ResourceGroup({
  orgId,
  type,
  label,
  subject,
  collection,
  icon: Icon,
  selected,
  onToggle,
  disabled,
}: {
  orgId: string;
  type: AttachmentResourceType;
  label: string;
  subject: string;
  collection: string;
  icon: typeof Bot;
  selected: Set<string>;
  onToggle: (type: AttachmentResourceType, id: string, on: boolean) => void;
  disabled: boolean;
}) {
  const { data, results, error, isLoading, mutate } =
    useScopedList<SharedResource>(collection, {
      orgId,
    });
  const resources = sortByName(results);

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4" /> {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Each group reads on its own, so each holds its own placeholder —
            until its list lands, "none yet" would be a false claim. A failed
            read says so, and offers to read again, rather than claiming the
            organization has none. */}
        {isLoading ? (
          <SwitchGridSkeleton rows={2} />
        ) : error && !data ? (
          <ListError
            error={error}
            subject={subject}
            onRetry={() => void mutate()}
          />
        ) : resources.length === 0 ? (
          <ListState variant="empty">
            No shared {label.toLowerCase()} in this organization yet.
          </ListState>
        ) : (
          <FieldGroup className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {resources.map((resource) => {
              const key = itemKey(type, resource.id);
              return (
                <FormSwitchField
                  key={resource.id}
                  name={key}
                  label={resource.name}
                  description={resource.description}
                  descriptionClassName="line-clamp-1"
                  checked={selected.has(key)}
                  onCheckedChange={(checked) =>
                    onToggle(type, resource.id, checked)
                  }
                  disabled={disabled}
                />
              );
            })}
          </FieldGroup>
        )}
      </CardContent>
    </Card>
  );
}

/** A section heading and its one-line lede, as the form's `h2` + `p`. */
function SectionHeadingSkeleton() {
  return (
    <>
      <div className="mb-1 flex h-7 items-center">
        <Skeleton className="h-5 w-40" />
      </div>
      <div className="mb-4 flex h-5 items-center">
        <Skeleton className="h-3.5 w-3/4" />
      </div>
    </>
  );
}

function BlueprintFormSkeleton({
  className,
  editing,
}: {
  className?: string;
  editing: boolean;
}) {
  return (
    <div className={className}>
      <FormSkeletonSet>
        <FormSkeletonGroup className="gap-4">
          <FieldSkeleton counter />
          <TextareaSkeleton counter />
        </FormSkeletonGroup>
      </FormSkeletonSet>
      <SectionHeadingSkeleton />
      {RESOURCE_GROUPS.map((group) => (
        <SwitchCardSkeleton key={group.type} className="mb-4" rows={2} />
      ))}
      <SectionHeadingSkeleton />
      <FormSkeletonSet>
        <FormSkeletonGroup className="gap-4">
          <TextareaSkeleton counter description={1} />
          <FieldSkeleton description={1} />
          <FieldSkeleton description={1} />
          <FieldSkeleton description={1} />
        </FormSkeletonGroup>
      </FormSkeletonSet>
      <FooterSkeleton buttons={editing ? 2 : 1} />
    </div>
  );
}

const RETRACTABLE_FIELDS = [
  "name",
  "description",
  "context",
  "taskModelProviderId",
  "memoryExtractionProviderId",
  "memoryEmbeddingProviderId",
] as const;

const INITIAL_DATA = {
  name: "",
  description: "",
  // Tier 2 pointer-settings stamped onto the workspace on apply (ADR-0008).
  context: "",
  taskModelProviderId: null as string | null,
  memoryExtractionProviderId: null as string | null,
  memoryEmbeddingProviderId: null as string | null,
};

function BlueprintForm({
  classNames,
  orgId,
  blueprintId,
}: {
  classNames?: string;
  orgId: string;
  blueprintId?: string;
}) {
  const returnPath = orgRoutes(orgId).settings.blueprints;

  // Org-scoped providers — the eligible set for Tier 2 pointer-settings, which
  // may only reference Shared resources (ADR-0008).
  const { results: providers, isLoading: providersLoading } =
    useScopedList<Provider>("providers", { orgId });

  // Selected items as a Set of `${type}:${id}` keys for cheap toggling.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const router = useRouter();

  const {
    loadState,
    formData,
    setFormData,
    validationErrors,
    isSubmitting,
    canSubmit,
    handleChange,
    toFieldChange,
    setField,
    submit,
  } = useEntityForm<typeof INITIAL_DATA, unknown, Blueprint>({
    initialData: INITIAL_DATA,
    entity: "blueprints",
    scope: { orgId },
    id: blueprintId,
    fromRecord: (blueprint) => ({
      name: blueprint.name,
      description: blueprint.description ?? "",
      context: blueprint.context ?? "",
      taskModelProviderId: blueprint.taskModelProviderId ?? null,
      memoryExtractionProviderId: blueprint.memoryExtractionProviderId ?? null,
      memoryEmbeddingProviderId: blueprint.memoryEmbeddingProviderId ?? null,
    }),
    // Sorted keys: deepEqual compares plain values, not Sets.
    sideState: [...selected].sort(),
    onSeed: (blueprint) =>
      setSelected(
        new Set(
          blueprint.items.map((i) => itemKey(i.resourceType, i.resourceId)),
        ),
      ),
    retractableFields: RETRACTABLE_FIELDS,
    buildPayload: (data) => {
      const items: BlueprintItem[] = [...selected].map((key) => {
        const [resourceType, resourceId] = key.split(":");
        return {
          resourceType: resourceType as AttachmentResourceType,
          resourceId,
        };
      });
      return {
        name: data.name,
        description: data.description || undefined,
        items,
        // Tier 2 pointer-settings (ADR-0008). Null clears the slot; on apply a
        // null slot leaves the workspace's existing value untouched.
        context: data.context || null,
        taskModelProviderId: data.taskModelProviderId,
        memoryExtractionProviderId: data.memoryExtractionProviderId,
        memoryEmbeddingProviderId: data.memoryEmbeddingProviderId,
      };
    },
    successMessage: () =>
      blueprintId ? "Blueprint updated" : "Blueprint created",
    onSuccess: () => router.push(returnPath),
  });

  const { dialogProps, openDeleteDialog } = useEntityDelete({
    entity: "blueprints",
    scope: { orgId },
    id: blueprintId,
    successMessage: "Blueprint deleted",
    onSuccess: () => router.push(returnPath),
  });

  const toggleItem = (
    type: AttachmentResourceType,
    id: string,
    on: boolean,
  ) => {
    const key = itemKey(type, id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
    // A Tier 2 pointer-setting can only target a provider this blueprint also
    // attaches. Removing a provider from the composer clears any Tier 2 slot
    // pointing at it, so we never stamp a workspace with an unattached provider.
    if (type === "provider" && !on) {
      setFormData((prev) => ({
        ...prev,
        taskModelProviderId:
          prev.taskModelProviderId === id ? null : prev.taskModelProviderId,
        memoryExtractionProviderId:
          prev.memoryExtractionProviderId === id
            ? null
            : prev.memoryExtractionProviderId,
        memoryEmbeddingProviderId:
          prev.memoryEmbeddingProviderId === id
            ? null
            : prev.memoryEmbeddingProviderId,
      }));
    }
  };

  // Tier 2 settings may only reference a provider the blueprint attaches (a
  // selected "provider:<id>" item). The memory slots additionally require the
  // provider to expose the relevant model, and each select is disabled when it
  // has no eligible provider, so an empty "Leave unset"-only dropdown never
  // shows.
  const attachedProviders = providers.filter((p) =>
    selected.has(itemKey("provider", p.id)),
  );

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
            placeholder="Starter kit"
            value={formData.name}
            onChange={toFieldChange("name")}
            disabled={isSubmitting}
            error={validationErrors.name}
            autoFocus
            trailing={
              <p className="text-xs text-muted-foreground">
                {formData.name.length}/{BLUEPRINT_NAME_MAX_LENGTH}
              </p>
            }
          />
          <ExpandableTextarea
            id="description"
            label="Description"
            placeholder="What this blueprint provisions..."
            value={formData.description}
            onChange={handleChange}
            disabled={isSubmitting}
            maxLength={BLUEPRINT_DESCRIPTION_MAX_LENGTH}
            error={validationErrors.description}
          />
        </FieldGroup>
      </FieldSet>

      <h2 className="text-lg font-semibold mb-1">Shared resources</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Pick the shared resources this blueprint provisions. Applying it to a
        workspace attaches each of these in one step.
      </p>

      {RESOURCE_GROUPS.map((group) => (
        <ResourceGroup
          key={group.type}
          orgId={orgId}
          type={group.type}
          label={group.label}
          subject={group.subject}
          collection={group.collection}
          icon={group.icon}
          selected={selected}
          onToggle={toggleItem}
          disabled={isSubmitting}
        />
      ))}

      <h2 className="text-lg font-semibold mb-1">Workspace settings</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Optional settings applied to the workspace when this blueprint is
        applied. Leave a setting unset to keep the workspace&apos;s existing
        value.
      </p>

      <FieldSet className="mb-6">
        <FieldGroup className="gap-4">
          <ExpandableTextarea
            id="context"
            label="Default context"
            placeholder="Optional context for the workspace"
            value={formData.context}
            onChange={handleChange}
            disabled={isSubmitting}
            className="!font-mono"
            maxLength={CONTEXT_MAX_LENGTH}
            error={validationErrors.context}
            description="Additional context included in all chats in the workspace."
          />

          <ProviderPointerSelect
            kind="task"
            label="Task model provider"
            noneLabel="Leave unset"
            value={formData.taskModelProviderId}
            onChange={(value) => setField("taskModelProviderId", value)}
            disabled={isSubmitting}
            disableWhenEmpty
            error={validationErrors.taskModelProviderId}
            providers={attachedProviders}
            description="Provider used for generating chat titles. Attach a provider under Shared resources to enable this."
          />

          <ProviderPointerSelect
            kind="memoryExtraction"
            label="Memory extraction provider"
            noneLabel="Leave unset"
            value={formData.memoryExtractionProviderId}
            onChange={(value) => setField("memoryExtractionProviderId", value)}
            disabled={isSubmitting}
            disableWhenEmpty
            error={validationErrors.memoryExtractionProviderId}
            providers={attachedProviders}
            description="Provider used to extract memories from conversations. Must be attached by this blueprint and expose a memory-extraction model."
          />

          <ProviderPointerSelect
            kind="embedding"
            label="Memory embedding provider"
            noneLabel="Leave unset"
            value={formData.memoryEmbeddingProviderId}
            onChange={(value) => setField("memoryEmbeddingProviderId", value)}
            disabled={isSubmitting}
            disableWhenEmpty
            error={validationErrors.memoryEmbeddingProviderId}
            providers={attachedProviders}
            description="Provider used for memory embeddings. Must be attached by this blueprint and expose an embedding model."
          />
        </FieldGroup>
      </FieldSet>

      <FormFooterButtons
        type="submit"
        submitText={blueprintId ? "Update" : "Save"}
        pending={isSubmitting}
        submitDisabled={isSubmitting || !canSubmit}
        deleteVisible={!!blueprintId}
        deleteDisabled={isSubmitting}
        onDelete={openDeleteDialog}
      />

      <DeleteConfirmDialog
        noun="blueprint"
        consequence="Workspaces already provisioned from it are unaffected."
        {...dialogProps}
      />
    </form>
  );

  return (
    <DetailFormState
      {...loadState}
      // The three provider selects resolve their stored ids against this
      // list; without it they'd render blank over a saved Blueprint.
      isLoading={providersLoading || loadState.isLoading}
      subject="blueprint"
      skeleton={
        <BlueprintFormSkeleton className={classNames} editing={!!blueprintId} />
      }
      backHref={returnPath}
      backLabel="Back to blueprints"
    >
      {form}
    </DetailFormState>
  );
}

export { BlueprintForm };
