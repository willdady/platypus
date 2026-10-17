"use client";

import { useState } from "react";
import type { KanbanLabel } from "@platypus/schemas";
import { readableTextColor } from "@/lib/color";
import { cn } from "@/lib/utils";
import { useMutation } from "@/hooks/use-mutation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

/**
 * Each board dialog is mounted only while it is the board's open dialog, so
 * its inputs start fresh every time it opens. `onSubmit` resolves once the
 * write has landed or been refused; the board closes the dialog on success.
 */
type BoardDialogProps<Values> = {
  readonly onSubmit: (values: Values) => Promise<void>;
  readonly onClose: () => void;
};

/**
 * Runs `submit` with the trimmed text once per submit: a double click or
 * Enter held down would otherwise create duplicate columns or cards. Blank
 * text submits nothing.
 */
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
          <DialogTitle>Add Column</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="py-4">
            <Label htmlFor="columnName">Column Name</Label>
            <Input
              id="columnName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter column name"
              className="mt-2"
              autoFocus
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
          <DialogTitle>Add Card</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="py-4 flex flex-col gap-4">
            <div>
              <Label htmlFor="cardTitle">Card Title</Label>
              <Input
                id="cardTitle"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Enter card title"
                className="mt-2"
                autoFocus
              />
            </div>
            {labels.length > 0 && (
              <div role="group" aria-labelledby="new-card-labels-label">
                <p
                  id="new-card-labels-label"
                  className="flex items-center gap-2 text-sm leading-none font-medium"
                >
                  Labels
                </p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {labels.map((label) => {
                    const isActive = labelIds.includes(label.id);
                    return (
                      <Badge
                        key={label.id}
                        className={cn(
                          "cursor-pointer transition-opacity border-0",
                          !isActive && "opacity-40",
                        )}
                        style={{
                          backgroundColor: label.color,
                          color: readableTextColor(label.color),
                        }}
                        onClick={() =>
                          setLabelIds((prev) =>
                            prev.includes(label.id)
                              ? prev.filter((id) => id !== label.id)
                              : [...prev, label.id],
                          )
                        }
                      >
                        {label.name}
                      </Badge>
                    );
                  })}
                </div>
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
          <DialogTitle>Edit Column</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="py-4">
            <Label htmlFor="editColumnName">Column Name</Label>
            <Input
              id="editColumnName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter column name"
              className="mt-2"
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
