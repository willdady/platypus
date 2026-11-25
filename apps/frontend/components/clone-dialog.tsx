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
import { FormTextField } from "@/components/form-text-field";
import { useBackendUrl } from "@/components/auth-provider";
import { useMutation } from "@/hooks/use-mutation";
import type { WriteOutcome } from "@/lib/api-write";

// why: render only while cloning, so each dialog starts from its item's name
export function CloneDialog({
  noun,
  original,
  onClose,
  create,
  onCreated,
  note,
  nameMaxLength,
  disabled = false,
}: {
  noun: string;
  original: string;
  onClose: () => void;
  // why: the base URL is passed in so the caller never asserts the auth context
  create: (
    name: string,
    backendUrl: string,
  ) => Promise<WriteOutcome<{ id: string }>>;
  onCreated: (id: string) => void;
  note?: ReactNode;
  // why: the (copy) suffix can push a near-limit name over the schema's limit
  nameMaxLength: number;
  // why: a caller that can't assemble the copy's references disables Clone instead
  disabled?: boolean;
}) {
  const backendUrl = useBackendUrl();
  const [name, setName] = useState(`${original} (copy)`);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const inputId = `clone-${noun}-name`;
  const nounLabel = noun.charAt(0).toUpperCase() + noun.slice(1);

  // why: the ref guard drops a second confirm while the first is in flight
  const { run: confirm, pending } = useMutation(async () => {
    if (!backendUrl) return;
    const outcome = await create(name, backendUrl);
    if (outcome.outcome !== "success") {
      // why: a refused name goes on the field; every other failure keeps the message
      const fieldErrors =
        outcome.outcome === "invalid" ? outcome.fieldErrors : {};
      const nameIssue = fieldErrors.name;
      const otherIssue = Object.keys(fieldErrors).some(
        (field) => field !== "name",
      );
      setNameError(nameIssue ?? null);
      setError(nameIssue && !otherIssue ? null : outcome.message);
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
        <FormTextField
          label="Name"
          name={inputId}
          value={name}
          onChange={(value) => {
            setName(value);
            setNameError(null);
            setError(null);
          }}
          placeholder={`${nounLabel} name`}
          maxLength={nameMaxLength}
          error={nameError}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !disabled) {
              void confirm();
            }
          }}
        />
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
