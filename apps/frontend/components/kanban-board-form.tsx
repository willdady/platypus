"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { nanoid } from "nanoid";
import { Trash2, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldError } from "@/components/ui/field";
import { useBackendUrl } from "@/app/client-context";
import { joinUrl, parseValidationErrors } from "@/lib/utils";
import { KANBAN_LABEL_COLORS, type KanbanLabel } from "@platypus/schemas";
import { toast } from "sonner";

const DEFAULT_COLOR = KANBAN_LABEL_COLORS[5].value; // Blue

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
  const [name, setName] = useState(board?.name ?? "");
  const [description, setDescription] = useState(board?.description ?? "");
  const [labels, setLabels] = useState<KanbanLabel[]>(board?.labels ?? []);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const isEditing = !!board;

  const handleAddLabel = () => {
    setLabels((prev) => [
      ...prev,
      { id: nanoid(), name: "", color: DEFAULT_COLOR },
    ]);
  };

  const handleLabelNameChange = (id: string, value: string) => {
    setLabels((prev) =>
      prev.map((l) => (l.id === id ? { ...l, name: value } : l)),
    );
  };

  const handleLabelColorChange = (id: string, color: string) => {
    setLabels((prev) =>
      prev.map((l) => (l.id === id ? { ...l, color } : l)),
    );
  };

  const handleDeleteLabel = (id: string) => {
    setLabels((prev) => prev.filter((l) => l.id !== id));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setValidationErrors({});

    const url = isEditing
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/boards/${board.id}`,
        )
      : joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/boards`,
        );

    try {
      const response = await fetch(url, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || null,
          labels,
        }),
        credentials: "include",
      });

      if (response.ok) {
        if (isEditing) {
          toast.success("Board updated");
          onSuccess?.();
        } else {
          const data = await response.json();
          router.push(`/${orgId}/workspace/${workspaceId}/boards/${data.id}`);
        }
      } else {
        const errorData = await response.json();
        setValidationErrors(parseValidationErrors(errorData));
      }
    } catch (err) {
      console.error("Failed to save board:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field data-invalid={!!validationErrors.name}>
        <FieldLabel htmlFor="name">Name</FieldLabel>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Board name"
          disabled={isSubmitting}
          required
        />
        {validationErrors.name && (
          <FieldError>{validationErrors.name}</FieldError>
        )}
      </Field>
      <Field data-invalid={!!validationErrors.description}>
        <FieldLabel htmlFor="description">Description</FieldLabel>
        <Textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description"
          disabled={isSubmitting}
        />
        {validationErrors.description && (
          <FieldError>{validationErrors.description}</FieldError>
        )}
      </Field>

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
          <Plus className="h-4 w-4 mr-1" />
          Add Label
        </Button>
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={isSubmitting || isDeleting || !name.trim()}>
          {isEditing ? "Update" : "Create Board"}
        </Button>
        {isEditing && onDelete && (
          <Button
            type="button"
            variant="outline"
            onClick={onDelete}
            disabled={isSubmitting || isDeleting}
          >
            <Trash2 /> Delete
          </Button>
        )}
      </div>
    </form>
  );
}
