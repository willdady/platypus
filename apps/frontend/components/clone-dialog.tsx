"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { useBackendUrl } from "@/components/auth-provider";
import type { WriteOutcome } from "@/lib/api-write";

/**
 * The Clone dialog of the `card-conventions` Clone section: names the copy
 * `<name> (copy)`, editable, and keeps a failed create's reason inline with the
 * dialog open. Render it only while a Clone is under way, so each one starts
 * from its item's name.
 */
export function CloneDialog({
  noun,
  original,
  onClose,
  create,
  onCreated,
  note,
}: {
  /** The item's kind, capitalised, as in "Clone Agent". */
  noun: string;
  /** The name of the item being cloned. */
  original: string;
  onClose: () => void;
  /**
   * Sends the create for a clone with this name. The base URL is passed in so
   * the caller never has to non-null-assert the auth context.
   */
  create: (
    name: string,
    backendUrl: string,
  ) => Promise<WriteOutcome<{ id: string }>>;
  /** After a successful create, the dialog closed: revalidate and navigate. */
  onCreated: (id: string) => void;
  /** Shown above the name, such as what the copy leaves out. */
  note?: ReactNode;
}) {
  const backendUrl = useBackendUrl();
  const [name, setName] = useState(`${original} (copy)`);
  const [error, setError] = useState<string | null>(null);
  const inputId = `clone-${noun.toLowerCase()}-name`;

  const confirm = async () => {
    if (!backendUrl) return;
    const outcome = await create(name, backendUrl);
    if (outcome.outcome !== "success") {
      setError(outcome.message);
      return;
    }
    onClose();
    onCreated(outcome.data.id);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clone {noun}</DialogTitle>
          <DialogDescription>
            Enter a name for the cloned {noun.toLowerCase()}.
          </DialogDescription>
        </DialogHeader>
        {note}
        <Field>
          <FieldLabel htmlFor={inputId}>Name</FieldLabel>
          <Input
            id={inputId}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder={`${noun} name`}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void confirm();
              }
            }}
          />
        </Field>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={confirm}>Clone</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
