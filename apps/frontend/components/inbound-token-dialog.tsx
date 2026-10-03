"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldLabel } from "@/components/ui/field";
import { Copy, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { formatDateTime } from "@/lib/format-date";
import { copyToClipboard } from "@/lib/clipboard";

/** The fire endpoint an external caller POSTs to (ADR-0030). */
export const inboundEndpointUrl = (backendUrl: string, triggerId: string) =>
  `${backendUrl.replace(/\/+$/, "")}/hooks/triggers/${triggerId}`;

/** A ready-to-run test call, each declared input filled with a placeholder. */
export const inboundCurlCommand = (
  endpointUrl: string,
  token: string,
  inputNames: string[],
) => {
  const inputs = Object.fromEntries(inputNames.map((n) => [n, `<${n}>`]));
  return [
    `curl -X POST '${endpointUrl}' \\`,
    `  -H 'Authorization: Bearer ${token}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${JSON.stringify({ inputs })}'`,
  ].join("\n");
};

const CopyRow = ({
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
        onClick={async (event) => {
          const row = event.currentTarget.parentElement ?? undefined;
          if (await copyToClipboard(value, row)) {
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

/**
 * Shows an Inbound Trigger's token the one time it is readable — on creation
 * and on regenerate. Only its hash is stored, so once this closes the token
 * cannot be shown again; a lost one is replaced by regenerating.
 */
export const InboundTokenDialog = ({
  open,
  token,
  endpointUrl,
  inputNames,
  expiresAt,
  onClose,
}: {
  open: boolean;
  token: string;
  endpointUrl: string;
  inputNames: string[];
  expiresAt?: string | Date | null;
  onClose: () => void;
}) => (
  <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
    <DialogContent
      // Closing is the one irreversible step, so neither a stray click
      // outside, Escape nor a corner X may do it: only the button does.
      onPointerDownOutside={(e) => e.preventDefault()}
      onEscapeKeyDown={(e) => e.preventDefault()}
      showCloseButton={false}
    >
      <DialogHeader>
        <DialogTitle>Copy the token now</DialogTitle>
        <DialogDescription>
          The system that calls this trigger sends this token as{" "}
          <code>Authorization: Bearer &lt;token&gt;</code>.
        </DialogDescription>
      </DialogHeader>

      <Alert>
        <TriangleAlert />
        <AlertDescription>
          This is the only time the token is shown. If you lose it, regenerate
          it on the trigger&apos;s page. That stops the old one working.
        </AlertDescription>
      </Alert>

      <CopyRow
        id="inbound-token"
        label="Token"
        value={token}
        copiedMessage="Token copied to clipboard"
      />
      <CopyRow
        id="inbound-endpoint"
        label="Endpoint"
        value={endpointUrl}
        copiedMessage="Endpoint copied to clipboard"
      />
      <CopyRow
        id="inbound-curl"
        label="Test with curl"
        value={inboundCurlCommand(endpointUrl, token, inputNames)}
        copiedMessage="Command copied to clipboard"
        multiline
      />
      {expiresAt && (
        <p className="text-sm text-muted-foreground">
          Expires {formatDateTime(expiresAt)}.
        </p>
      )}

      <DialogFooter>
        <Button type="button" className="cursor-pointer" onClick={onClose}>
          I&apos;ve copied it
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
