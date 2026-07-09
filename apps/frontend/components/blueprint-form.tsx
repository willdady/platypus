"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useRouter } from "next/navigation";
import { Bot, Plug, Sparkles, Trash2, Unplug } from "lucide-react";
import type {
  Blueprint,
  BlueprintItem,
  AttachmentResourceType,
  Provider,
} from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, parseValidationErrors, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";

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

const BlueprintForm = ({
  classNames,
  orgId,
  blueprintId,
}: {
  classNames?: string;
  orgId: string;
  blueprintId?: string;
}) => {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const collectionUrl = `/organizations/${orgId}/blueprints`;
  const returnPath = `/${orgId}/settings/blueprints`;

  const { data: blueprint, isLoading } = useSWR<Blueprint>(
    blueprintId && user
      ? joinUrl(backendUrl, `${collectionUrl}/${blueprintId}`)
      : null,
    fetcher,
  );

  // Org-scoped providers — the eligible set for Tier 2 pointer-settings, which
  // may only reference Shared resources (ADR-0008).
  const { data: providersData } = useSWR<{ results: Provider[] }>(
    backendUrl && user
      ? joinUrl(backendUrl, `/organizations/${orgId}/providers`)
      : null,
    fetcher,
  );
  const providers = providersData?.results || [];

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    // Tier 2 pointer-settings stamped onto the workspace on apply (ADR-0008).
    context: "",
    taskModelProviderId: null as string | null,
    memoryExtractionProviderId: null as string | null,
    memoryEmbeddingProviderId: null as string | null,
  });
  // Selected items as a Set of `${type}:${id}` keys for cheap toggling.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});
  const [formError, setFormError] = useState<string | null>(null);

  const router = useRouter();

  useResetOnChange(blueprint, () => {
    if (blueprint) {
      setFormData({
        name: blueprint.name,
        description: blueprint.description ?? "",
        context: blueprint.context ?? "",
        taskModelProviderId: blueprint.taskModelProviderId ?? null,
        memoryExtractionProviderId:
          blueprint.memoryExtractionProviderId ?? null,
        memoryEmbeddingProviderId: blueprint.memoryEmbeddingProviderId ?? null,
      });
      setSelected(
        new Set(
          blueprint.items.map((i) => itemKey(i.resourceType, i.resourceId)),
        ),
      );
    }
  });

  if (isLoading) {
    return <div className={classNames}>Loading...</div>;
  }

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const { id, value } = e.target;
    if (validationErrors[id]) {
      setValidationErrors((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
    setFormData((prev) => ({ ...prev, [id]: value }));
  };

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

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setValidationErrors({});
    setFormError(null);
    try {
      const items: BlueprintItem[] = [...selected].map((key) => {
        const [resourceType, resourceId] = key.split(":");
        return {
          resourceType: resourceType as AttachmentResourceType,
          resourceId,
        };
      });
      const payload = {
        name: formData.name,
        description: formData.description || undefined,
        items,
        // Tier 2 pointer-settings (ADR-0008). Null clears the slot; on apply a
        // null slot leaves the workspace's existing value untouched.
        context: formData.context || null,
        taskModelProviderId: formData.taskModelProviderId,
        memoryExtractionProviderId: formData.memoryExtractionProviderId,
        memoryEmbeddingProviderId: formData.memoryEmbeddingProviderId,
      };

      const url = blueprintId
        ? joinUrl(backendUrl, `${collectionUrl}/${blueprintId}`)
        : joinUrl(backendUrl, collectionUrl);
      const method = blueprintId ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
      });

      if (response.ok) {
        router.push(returnPath);
      } else {
        const errorData = await response.json();
        if (response.status === 409) {
          setValidationErrors({ name: errorData.error || errorData.message });
        } else if (response.status === 422) {
          setFormError(
            errorData.error ||
              "A blueprint may only list organization-scoped resources.",
          );
        } else {
          setValidationErrors(parseValidationErrors(errorData));
        }
      }
    } catch (error) {
      console.error("Error saving blueprint:", error);
      setFormError("An unexpected error occurred.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!blueprintId) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch(
        joinUrl(backendUrl, `${collectionUrl}/${blueprintId}`),
        { method: "DELETE", credentials: "include" },
      );
      if (response.ok) {
        router.push(returnPath);
      } else {
        const errorData = await response.json();
        setDeleteError(
          errorData.error || errorData.message || "Failed to delete blueprint",
        );
        setIsDeleting(false);
      }
    } catch (error) {
      console.error("Error deleting blueprint:", error);
      setDeleteError("An unexpected error occurred");
      setIsDeleting(false);
    }
  };

  return (
    <div className={classNames}>
      <FieldSet className="mb-6">
        <FieldGroup className="gap-4">
          <Field data-invalid={!!validationErrors.name}>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              placeholder="Starter kit"
              value={formData.name}
              onChange={handleChange}
              disabled={isSubmitting}
              aria-invalid={!!validationErrors.name}
              autoFocus
            />
            <div className="flex justify-between mt-1">
              {validationErrors.name ? (
                <FieldError>{validationErrors.name}</FieldError>
              ) : (
                <div />
              )}
              <p className="text-xs text-muted-foreground">
                {formData.name.length}/100
              </p>
            </div>
          </Field>
          <Field data-invalid={!!validationErrors.description}>
            <ExpandableTextarea
              id="description"
              label="Description"
              placeholder="What this blueprint provisions..."
              value={formData.description}
              onChange={handleChange}
              disabled={isSubmitting}
              maxLength={500}
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
              maxLength={1000}
              aria-invalid={!!validationErrors.context}
              error={validationErrors.context}
            />
            <FieldDescription>
              Additional context included in all chats in the workspace.
            </FieldDescription>
          </Field>

          <Field data-invalid={!!validationErrors.taskModelProviderId}>
            <FieldLabel htmlFor="taskModelProviderId">
              Task model provider
            </FieldLabel>
            <Select
              value={formData.taskModelProviderId || "none"}
              onValueChange={(value) =>
                setFormData((prev) => ({
                  ...prev,
                  taskModelProviderId: value === "none" ? null : value,
                }))
              }
              disabled={isSubmitting || attachedProviders.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Leave unset</SelectItem>
                {attachedProviders.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Provider used for generating chat titles and tags. Attach a
              provider under Shared resources to enable this.
            </FieldDescription>
            {validationErrors.taskModelProviderId && (
              <FieldError>{validationErrors.taskModelProviderId}</FieldError>
            )}
          </Field>

          <Field data-invalid={!!validationErrors.memoryExtractionProviderId}>
            <FieldLabel htmlFor="memoryExtractionProviderId">
              Memory extraction provider
            </FieldLabel>
            <Select
              value={formData.memoryExtractionProviderId || "none"}
              onValueChange={(value) =>
                setFormData((prev) => ({
                  ...prev,
                  memoryExtractionProviderId: value === "none" ? null : value,
                }))
              }
              disabled={isSubmitting || memoryExtractionProviders.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Leave unset</SelectItem>
                {memoryExtractionProviders.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Provider used to extract memories from conversations. Must be
              attached by this blueprint and expose a memory-extraction model.
            </FieldDescription>
            {validationErrors.memoryExtractionProviderId && (
              <FieldError>
                {validationErrors.memoryExtractionProviderId}
              </FieldError>
            )}
          </Field>

          <Field data-invalid={!!validationErrors.memoryEmbeddingProviderId}>
            <FieldLabel htmlFor="memoryEmbeddingProviderId">
              Memory embedding provider
            </FieldLabel>
            <Select
              value={formData.memoryEmbeddingProviderId || "none"}
              onValueChange={(value) =>
                setFormData((prev) => ({
                  ...prev,
                  memoryEmbeddingProviderId: value === "none" ? null : value,
                }))
              }
              disabled={isSubmitting || memoryEmbeddingProviders.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Leave unset</SelectItem>
                {memoryEmbeddingProviders.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Provider used for memory embeddings. Must be attached by this
              blueprint and expose an embedding model.
            </FieldDescription>
            {validationErrors.memoryEmbeddingProviderId && (
              <FieldError>
                {validationErrors.memoryEmbeddingProviderId}
              </FieldError>
            )}
          </Field>
        </FieldGroup>
      </FieldSet>

      {formError && <FieldError className="mb-4">{formError}</FieldError>}

      <div className="flex gap-2">
        <Button
          className="cursor-pointer"
          onClick={handleSubmit}
          disabled={isSubmitting}
        >
          {blueprintId ? "Update" : "Save"}
        </Button>

        {blueprintId && (
          <Button
            className="cursor-pointer"
            variant="outline"
            onClick={() => setIsDeleteDialogOpen(true)}
            disabled={isSubmitting}
          >
            <Trash2 /> Delete
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={(open) => {
          setIsDeleteDialogOpen(open);
          if (!open) setDeleteError(null);
        }}
        title="Delete Blueprint"
        description="Are you sure you want to delete this blueprint? Workspaces already provisioned from it are unaffected."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDelete}
        loading={isDeleting}
        error={deleteError}
      />
    </div>
  );
};

export { BlueprintForm };
