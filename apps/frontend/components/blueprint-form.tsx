"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { FormTextField } from "@/components/form-text-field";
import { FormSelectField } from "@/components/form-select-field";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { SelectItem } from "@/components/ui/select";
import { EntityDeleteDialog } from "@/components/entity-delete-dialog";
import { DetailFormState } from "@/components/detail-form-state";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import { useState } from "react";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useRouter } from "next/navigation";
import { Bot, Plug, Sparkles, Unplug } from "lucide-react";
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
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { retractFieldError } from "@/lib/form-errors";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { orgRoutes } from "@/lib/routes";

// The composer lists every Shared resource the org owns, grouped by type. A
// Blueprint may only list org-scoped resources, so these org collections are
// exactly the eligible set (ADR-0008).
const RESOURCE_GROUPS: {
  type: AttachmentResourceType;
  label: string;
  collection: string;
  icon: typeof Bot;
}[] = [
  { type: "agent", label: "Agents", collection: "agents", icon: Bot },
  { type: "skill", label: "Skills", collection: "skills", icon: Sparkles },
  { type: "mcp", label: "MCP servers", collection: "mcps", icon: Plug },
  {
    type: "provider",
    label: "Providers",
    collection: "providers",
    icon: Unplug,
  },
];

type SharedResource = { id: string; name: string; description?: string };

const itemKey = (type: AttachmentResourceType, id: string) => `${type}:${id}`;

const ResourceGroup = ({
  orgId,
  type,
  label,
  collection,
  icon: Icon,
  selected,
  onToggle,
  disabled,
}: {
  orgId: string;
  type: AttachmentResourceType;
  label: string;
  collection: string;
  icon: typeof Bot;
  selected: Set<string>;
  onToggle: (type: AttachmentResourceType, id: string, on: boolean) => void;
  disabled: boolean;
}) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const { data } = useSWR<{ results: SharedResource[] }>(
    backendUrl && user
      ? joinUrl(backendUrl, `/organizations/${orgId}/${collection}`)
      : null,
    fetcher,
  );
  const resources = [...(data?.results || [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4" /> {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {resources.length === 0 ? (
          <FieldDescription>
            No shared {label.toLowerCase()} in this organization yet.
          </FieldDescription>
        ) : (
          <FieldGroup className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {resources.map((resource) => {
              const key = itemKey(type, resource.id);
              return (
                <Field key={resource.id} orientation="horizontal">
                  <Switch
                    id={key}
                    className="cursor-pointer"
                    checked={selected.has(key)}
                    onCheckedChange={(checked) =>
                      onToggle(type, resource.id, checked)
                    }
                    disabled={disabled}
                  />
                  <FieldLabel htmlFor={key}>
                    <div className="flex flex-col">
                      <p>{resource.name}</p>
                      {resource.description && (
                        <p className="text-xs text-muted-foreground line-clamp-1">
                          {resource.description}
                        </p>
                      )}
                    </div>
                  </FieldLabel>
                </Field>
              );
            })}
          </FieldGroup>
        )}
      </CardContent>
    </Card>
  );
};

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

const BlueprintForm = ({
  classNames,
  orgId,
  blueprintId,
}: {
  classNames?: string;
  orgId: string;
  blueprintId?: string;
}) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const returnPath = orgRoutes(orgId).settings.blueprints;

  // Org-scoped providers — the eligible set for Tier 2 pointer-settings, which
  // may only reference Shared resources (ADR-0008).
  const { data: providersData } = useSWR<{ results: Provider[] }>(
    backendUrl && user
      ? joinUrl(backendUrl, `/organizations/${orgId}/providers`)
      : null,
    fetcher,
  );
  const providers = providersData?.results || [];

  // Selected items as a Set of `${type}:${id}` keys for cheap toggling.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [formError, setFormError] = useState<string | null>(null);

  const router = useRouter();

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
    onSuccess: () => router.push(returnPath),
    onError: (message) => setFormError(message),
  });

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    deleteError,
    openDeleteDialog,
    handleDelete,
  } = useEntityDelete({
    entity: "blueprints",
    scope: { orgId },
    id: blueprintId,
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
  // provider to expose the relevant model. Each select is disabled when it has
  // no eligible provider, so an empty "Leave unset"-only dropdown never shows.
  const attachedProviders = providers.filter((p) =>
    selected.has(itemKey("provider", p.id)),
  );
  const memoryExtractionProviders = attachedProviders.filter(
    (p) => p.memoryExtractionModelId,
  );
  const memoryEmbeddingProviders = attachedProviders.filter(
    (p) => (p as { embeddingModelId?: string }).embeddingModelId,
  );

  const form = (
    <div className={classNames}>
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
          <Field data-invalid={!!validationErrors.description}>
            <ExpandableTextarea
              id="description"
              label="Description"
              placeholder="What this blueprint provisions..."
              value={formData.description}
              onChange={handleChange}
              disabled={isSubmitting}
              maxLength={BLUEPRINT_DESCRIPTION_MAX_LENGTH}
              aria-invalid={!!validationErrors.description}
              error={validationErrors.description}
            />
          </Field>
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
          <Field data-invalid={!!validationErrors.context}>
            <ExpandableTextarea
              id="context"
              label="Default context"
              placeholder="Optional context for the workspace"
              value={formData.context}
              onChange={handleChange}
              disabled={isSubmitting}
              className="!font-mono"
              maxLength={CONTEXT_MAX_LENGTH}
              aria-invalid={!!validationErrors.context}
              error={validationErrors.context}
            />
            <FieldDescription>
              Additional context included in all chats in the workspace.
            </FieldDescription>
          </Field>

          <FormSelectField
            label="Task model provider"
            name="taskModelProviderId"
            value={formData.taskModelProviderId || "none"}
            onValueChange={(value) => {
              setValidationErrors((prev) =>
                retractFieldError(prev, "taskModelProviderId"),
              );
              setFormData((prev) => ({
                ...prev,
                taskModelProviderId: value === "none" ? null : value,
              }));
            }}
            disabled={isSubmitting || attachedProviders.length === 0}
            placeholder="Select a provider"
            error={validationErrors.taskModelProviderId}
            description="Provider used for generating chat titles and tags. Attach a provider under Shared resources to enable this."
          >
            <SelectItem value="none">Leave unset</SelectItem>
            {attachedProviders.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.name}
              </SelectItem>
            ))}
          </FormSelectField>

          <FormSelectField
            label="Memory extraction provider"
            name="memoryExtractionProviderId"
            value={formData.memoryExtractionProviderId || "none"}
            onValueChange={(value) => {
              setValidationErrors((prev) =>
                retractFieldError(prev, "memoryExtractionProviderId"),
              );
              setFormData((prev) => ({
                ...prev,
                memoryExtractionProviderId: value === "none" ? null : value,
              }));
            }}
            disabled={isSubmitting || memoryExtractionProviders.length === 0}
            placeholder="Select a provider"
            error={validationErrors.memoryExtractionProviderId}
            description="Provider used to extract memories from conversations. Must be attached by this blueprint and expose a memory-extraction model."
          >
            <SelectItem value="none">Leave unset</SelectItem>
            {memoryExtractionProviders.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.name}
              </SelectItem>
            ))}
          </FormSelectField>

          <FormSelectField
            label="Memory embedding provider"
            name="memoryEmbeddingProviderId"
            value={formData.memoryEmbeddingProviderId || "none"}
            onValueChange={(value) => {
              setValidationErrors((prev) =>
                retractFieldError(prev, "memoryEmbeddingProviderId"),
              );
              setFormData((prev) => ({
                ...prev,
                memoryEmbeddingProviderId: value === "none" ? null : value,
              }));
            }}
            disabled={isSubmitting || memoryEmbeddingProviders.length === 0}
            placeholder="Select a provider"
            error={validationErrors.memoryEmbeddingProviderId}
            description="Provider used for memory embeddings. Must be attached by this blueprint and expose an embedding model."
          >
            <SelectItem value="none">Leave unset</SelectItem>
            {memoryEmbeddingProviders.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.name}
              </SelectItem>
            ))}
          </FormSelectField>
        </FieldGroup>
      </FieldSet>

      {formError && <FieldError className="mb-4">{formError}</FieldError>}

      <FormFooterButtons
        submitText={blueprintId ? "Update" : "Save"}
        onSubmit={() => void submit()}
        submitDisabled={isSubmitting || !canSubmit}
        deleteVisible={!!blueprintId}
        deleteDisabled={isSubmitting}
        onDelete={openDeleteDialog}
      />

      <EntityDeleteDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete Blueprint"
        description="Are you sure you want to delete this blueprint? Workspaces already provisioned from it are unaffected."
        onConfirm={handleDelete}
        loading={isDeleting}
        error={deleteError}
      />
    </div>
  );

  return (
    <DetailFormState
      {...loadState}
      subject="blueprint"
      backHref={returnPath}
      backLabel="Back to blueprints"
    >
      {form}
    </DetailFormState>
  );
};

export { BlueprintForm };
