"use client";

import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { nanoid } from "nanoid";
import { Trash2, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FormTextField } from "@/components/form-text-field";
import { FormTextareaField } from "@/components/form-textarea-field";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/field";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import { useBackendUrl } from "@/components/auth-provider";
import { joinUrl } from "@/lib/utils";
import { useEntityForm } from "@/hooks/use-entity-form";
import { KANBAN_LABEL_COLORS, type KanbanLabel } from "@platypus/schemas";
import { toast } from "sonner";
import { workspaceRoutes } from "@/lib/routes";

const DEFAULT_COLOR = KANBAN_LABEL_COLORS[5].value; // Blue

// `labels` is excluded: this form has no field that retracts an error keyed
// to it, so including it here would disable Save forever the moment the
// server rejects a label.
const RETRACTABLE_FIELDS = ["name", "description"] as const;

type BoardFormData = {
  name: string;
  description: string;
  labels: KanbanLabel[];
};

export function KanbanBoardForm({
  orgId,
  workspaceId,
  board,
  onDelete,
  isDeleting,
  onSuccess,
}: {
  orgId: string;
  workspaceId: string;
  board?: {
    id: string;
    name: string;
    description?: string | null;
    labels?: KanbanLabel[];
  };
  onDelete?: () => void;
  isDeleting?: boolean;
  onSuccess?: () => void;
}) {
  const backendUrl = useBackendUrl();
  const router = useRouter();

  const isEditing = !!board;

  const {
    formData,
    setFormData,
    validationErrors,
    isSubmitting,
    canSubmit,
    toFieldChange,
    submit,
  } = useEntityForm<BoardFormData, { id: string }>({
    initialData: {
      name: board?.name ?? "",
      description: board?.description ?? "",
      labels: board?.labels ?? [],
    },
    entity: "boards",
    scope: { orgId, workspaceId },
    id: board?.id,
    retractableFields: RETRACTABLE_FIELDS,
    buildPayload: (data) => ({
      name: data.name,
      description: data.description || null,
      labels: data.labels,
    }),
    onSuccess: async (data) => {
      if (isEditing) {
        toast.success("Board updated");
        onSuccess?.();
        return;
      }
      const stateUrl = joinUrl(
        backendUrl,
        `/organizations/${orgId}/workspaces/${workspaceId}/boards/${data.id}/state`,
      );
      await mutate(stateUrl, { board: data, columns: [] }, false);
      router.push(workspaceRoutes(orgId, workspaceId).boards.detail(data.id));
    },
  });

  const { labels } = formData;

  const handleAddLabel = () => {
    setFormData((prev) => ({
      ...prev,
      labels: [
        ...prev.labels,
        { id: nanoid(), name: "", color: DEFAULT_COLOR },
      ],
    }));
  };

  const handleLabelNameChange = (id: string, value: string) => {
    setFormData((prev) => ({
      ...prev,
      labels: prev.labels.map((l) => (l.id === id ? { ...l, name: value } : l)),
    }));
  };

  const handleLabelColorChange = (id: string, color: string) => {
    setFormData((prev) => ({
      ...prev,
      labels: prev.labels.map((l) => (l.id === id ? { ...l, color } : l)),
    }));
  };

  const handleDeleteLabel = (id: string) => {
    setFormData((prev) => ({
      ...prev,
      labels: prev.labels.filter((l) => l.id !== id),
    }));
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="space-y-4"
    >
      <FormTextField
        label="Name"
        name="name"
        value={formData.name}
        onChange={toFieldChange("name")}
        placeholder="Board name"
        disabled={isSubmitting}
        required
        autoFocus={!isEditing}
        error={validationErrors.name}
      />
      <FormTextareaField
        label="Description"
        name="description"
        value={formData.description}
        onChange={toFieldChange("description")}
        placeholder="Optional description"
        disabled={isSubmitting}
        error={validationErrors.description}
      />

      <div className="space-y-2">
        <FieldLabel>Labels</FieldLabel>
        {labels.map((label) => (
          <div key={label.id} className="flex items-center gap-2">
            <Input
              value={label.name}
              onChange={(e) => handleLabelNameChange(label.id, e.target.value)}
              placeholder="Label name"
              disabled={isSubmitting}
              className="flex-1"
            />
            <div className="flex gap-1 flex-wrap">
              {KANBAN_LABEL_COLORS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  title={c.name}
                  onClick={() => handleLabelColorChange(label.id, c.value)}
                  className="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110"
                  style={{
                    backgroundColor: c.value,
                    borderColor:
                      label.color === c.value ? "white" : "transparent",
                    outline:
                      label.color === c.value ? `2px solid ${c.value}` : "none",
                  }}
                />
              ))}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => handleDeleteLabel(label.id)}
              disabled={isSubmitting}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleAddLabel}
          disabled={isSubmitting}
          className="mt-1"
        >
          <Plus className="h-4 w-4" />
          Add label
        </Button>
      </div>

      <FormFooterButtons
        type="submit"
        submitText="Save"
        submitDisabled={
          isSubmitting || isDeleting || !formData.name.trim() || !canSubmit
        }
        submitClassName=""
        deleteVisible={isEditing && !!onDelete}
        deleteDisabled={isSubmitting || isDeleting}
        deleteClassName=""
        onDelete={onDelete}
      />
    </form>
  );
}
