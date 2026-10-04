"use client";

import { TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CopyRow } from "@/components/inbound-token-dialog";

/**
 * Shows an A2A token the one time it is readable, beside the card URL the
 * client needs with it. Only its hash is stored, so once this closes the
 * token can't be shown again; a lost one is replaced by adding another.
 */
export const A2aTokenDialog = ({
  token,
  cardUrl,
  onClose,
}: {
  token: string;
  cardUrl: string;
  onClose: () => void;
}) => (
  <Dialog open onOpenChange={(next) => !next && onClose()}>
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
          Paste the agent card URL and this token into the A2A client. It sends
          the token as <code>Authorization: Bearer &lt;token&gt;</code>.
        </DialogDescription>
      </DialogHeader>

      <Alert>
        <TriangleAlert />
        <AlertTitle>Shown only once</AlertTitle>
        <AlertDescription>
          This is the only time the token is shown. If you lose it, delete it
          and add a new one.
        </AlertDescription>
      </Alert>

      <CopyRow
        id="a2a-token"
        label="Token"
        value={token}
        copiedMessage="Token copied to clipboard"
      />
      <CopyRow
        id="a2a-token-card-url"
        label="Agent card URL"
        value={cardUrl}
        copiedMessage="Agent card URL copied to clipboard"
      />

      <DialogFooter>
        <Button type="button" className="cursor-pointer" onClick={onClose}>
          I&apos;ve copied it
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
