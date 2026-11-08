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
import { useMutation } from "@/hooks/use-mutation";
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
  disabled = false,
}: {
  /** The item's kind, lowercase, as in "Clone agent". */
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
  /**
   * Whether Clone is unavailable. A caller that cannot assemble the copy's
   * references (a read still loading, or failed) passes this rather than
   * creating a clone with them silently dropped.
   */
  disabled?: boolean;
}) {
  const backendUrl = useBackendUrl();
  const [name, setName] = useState(`${original} (copy)`);
  const [error, setError] = useState<string | null>(null);
  const inputId = `clone-${noun}-name`;
  const nounLabel = noun.charAt(0).toUpperCase() + noun.slice(1);

  // The ref guard inside drops a second confirm — a double click, or Enter
  // twice — sent while the first create is still in flight.
  const { run: confirm, pending } = useMutation(async () => {
    if (!backendUrl) return;
    const outcome = await create(name, backendUrl);
    if (outcome.outcome !== "success") {
      setError(outcome.message);
      return;
    }
    onClose();
    onCreated(outcome.data.id);
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        onPointerDownOutside={(e) => {
          if (pending) {
            e.preventDefault();
          }
        }}
        onEscapeKeyDown={(e) => {
          if (pending) {
            e.preventDefault();
          }
        }}
        showCloseButton={!pending}
      >
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
            placeholder={`${nounLabel} name`}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !disabled) {
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
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={pending || disabled}>
            {pending ? "Cloning..." : "Clone"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
