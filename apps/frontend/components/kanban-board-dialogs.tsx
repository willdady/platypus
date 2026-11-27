"use client";

import { useState } from "react";
import type { KanbanLabel } from "@platypus/schemas";
import { useMutation } from "@/hooks/use-mutation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { KanbanLabelToggles } from "@/components/kanban-label-toggles";
import { FormTextField } from "@/components/form-text-field";

// why: each dialog unmounts when closed, so its inputs reset without an effect
type BoardDialogProps<Values> = {
  readonly onSubmit: (values: Values) => Promise<void>;
  readonly onClose: () => void;
};

function useGuardedSubmit(
  text: string,
  submit: (trimmed: string) => Promise<void>,
) {
  const mutation = useMutation(() => submit(text.trim()));
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (text.trim()) void mutation.run();
  };
  return { handleSubmit, pending: mutation.pending };
}

export function AddColumnDialog({
  onSubmit,
  onClose,
}: BoardDialogProps<{ name: string }>) {
  const [name, setName] = useState("");
  const { handleSubmit, pending } = useGuardedSubmit(name, (trimmed) =>
    onSubmit({ name: trimmed }),
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add column</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="py-4">
            <FormTextField
              label="Column Name"
              name="columnName"
              value={name}
              onChange={setName}
              placeholder="Enter column name"
              initialFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding..." : "Add column"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AddCardDialog({
  labels,
  onSubmit,
  onClose,
}: BoardDialogProps<{ title: string; labelIds: string[] }> & {
  readonly labels: KanbanLabel[];
}) {
  const [title, setTitle] = useState("");
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const { handleSubmit, pending } = useGuardedSubmit(title, (trimmed) =>
    onSubmit({ title: trimmed, labelIds }),
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add card</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="py-4 flex flex-col gap-4">
            <FormTextField
              label="Card Title"
              name="cardTitle"
              value={title}
              onChange={setTitle}
              placeholder="Enter card title"
              initialFocus
            />
            {labels.length > 0 && (
              <div>
                <p
                  id="new-card-labels-label"
                  className="flex items-center gap-2 text-sm leading-none font-medium"
                >
                  Labels
                </p>
                <KanbanLabelToggles
                  labels={labels}
                  selectedIds={labelIds}
                  onChange={setLabelIds}
                  labelledBy="new-card-labels-label"
                  className="mt-2"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding..." : "Add card"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EditColumnDialog({
  initialName,
  onSubmit,
  onClose,
}: BoardDialogProps<{ name: string }> & { readonly initialName: string }) {
  const [name, setName] = useState(initialName);
  const { handleSubmit, pending } = useGuardedSubmit(name, (trimmed) =>
    onSubmit({ name: trimmed }),
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit column</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="py-4">
            <FormTextField
              label="Column Name"
              name="editColumnName"
              value={name}
              onChange={setName}
              placeholder="Enter column name"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
