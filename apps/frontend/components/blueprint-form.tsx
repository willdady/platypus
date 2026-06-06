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
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useState } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useRouter } from "next/navigation";
import { Bot, Plug, Sparkles, Trash2, Unplug } from "lucide-react";
import type {
  Blueprint,
  BlueprintItem,
  AttachmentResourceType,
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

  const [formData, setFormData] = useState({ name: "", description: "" });
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
  };

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
