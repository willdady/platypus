"use client";

import type { Artifact } from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormTextField } from "@/components/form-text-field";
import { useEntityForm } from "@/hooks/use-entity-form";
import type { Scope, Serialized } from "@/lib/api-write";

/**
 * Renames one Artifact. The title is checked by the shared schema at the
 * backend, so an over-long one is refused and shown on the field rather than
 * quietly trimmed. The dialog closes on success and the list behind it
 * refreshes.
 */
export function ArtifactRenameDialog({
  artifact,
  scope,
  open,
  onOpenChange,
  onRenamed,
}: {
  artifact: Serialized<Artifact>;
  scope: Scope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRenamed: () => void;
}) {
  const { formData, isSubmitting, validationErrors, setField, submit } =
    useEntityForm<{ title: string }>({
      initialData: { title: artifact.title },
      guardUnsavedChanges: false,
      entity: "artifacts",
      scope,
      id: artifact.id,
      method: "PATCH",
      buildPayload: (data) => ({ title: data.title }),
      // A rename has no field a conflict could key to.
      conflictField: null,
      // The title's error is already in view.
      invalidMessage: null,
      successMessage: "Artifact renamed",
      onSuccess: () => {
        onRenamed();
        onOpenChange(false);
      },
    });

  const canSave = formData.title.trim().length > 0 && !isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onPointerDownOutside={(e) => {
          if (isSubmitting) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (isSubmitting) e.preventDefault();
        }}
        showCloseButton={false}
      >
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename Artifact</DialogTitle>
            <DialogDescription>
              Give it a title that says what it is.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <FormTextField
              label="Title"
              name="title"
              value={formData.title}
              onChange={(value) => setField("title", value)}
              placeholder="Artifact title"
              disabled={isSubmitting}
              error={validationErrors.title}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {isSubmitting ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
