"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldLabel } from "@/components/ui/field";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { copyToClipboard } from "@/lib/clipboard";

/** A read-only value with a button that copies it. */
export const CopyRow = ({
  id,
  label,
  value,
  copiedMessage,
  multiline = false,
}: {
  id: string;
  label: string;
  value: string;
  copiedMessage: string;
  multiline?: boolean;
}) => (
  <Field className="min-w-0">
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <div className="flex min-w-0 items-start gap-2">
      {multiline ? (
        <Textarea
          id={id}
          value={value}
          readOnly
          rows={value.split("\n").length}
          wrap="off"
          className="min-w-0 font-mono text-xs resize-none"
        />
      ) : (
        <Input id={id} value={value} readOnly className="font-mono text-xs" />
      )}
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="shrink-0 cursor-pointer"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={async () => {
          if (await copyToClipboard(value)) {
            toast.success(copiedMessage);
          } else {
            // Leave the value selected so Ctrl+C still gets it.
            const input = document.getElementById(id);
            if (
              input instanceof HTMLInputElement ||
              input instanceof HTMLTextAreaElement
            )
              input.select();
            toast.error("Couldn't copy. Select the text and press Ctrl+C.");
          }
        }}
      >
        <Copy className="h-4 w-4" />
      </Button>
    </div>
  </Field>
);
