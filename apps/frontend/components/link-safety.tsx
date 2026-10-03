"use client";

import { CopyIcon, ExternalLinkIcon } from "lucide-react";
import type { LinkSafetyConfig, LinkSafetyModalProps } from "streamdown";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The "Open external link?" confirmation, drawn with the app's Radix Dialog
 * rather than Streamdown's built-in modal. A plain portalled div can't be
 * clicked under another modal Radix layer (a card Dialog sets
 * `pointer-events: none` on body); a nested Radix Dialog can.
 */
export const LinkSafetyDialog = ({
  isOpen,
  onClose,
  onConfirm,
  url,
}: LinkSafetyModalProps) => {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied to clipboard");
    } catch {
      toast.error("Failed to copy link");
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ExternalLinkIcon className="size-5" />
            Open external link?
          </DialogTitle>
          <DialogDescription>
            You&apos;re about to visit an external website.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-32 overflow-y-auto rounded-md bg-muted p-3 font-mono text-sm break-all">
          {url}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCopy}>
            <CopyIcon />
            Copy link
          </Button>
          <Button
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            <ExternalLinkIcon />
            Open link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Every Markdown renderer showing agent-writable content uses this. */
export const linkSafety: LinkSafetyConfig = {
  enabled: true,
  // Same-origin links are the app's own pages; only external ones confirm.
  onLinkCheck: (url) => {
    try {
      return (
        new URL(url, window.location.href).origin === window.location.origin
      );
    } catch {
      return false;
    }
  },
  renderModal: (props) => <LinkSafetyDialog {...props} />,
};
