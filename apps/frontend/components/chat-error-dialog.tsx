"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { TriangleAlert, Copy, Check } from "lucide-react";

interface ChatErrorDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  error: Error | undefined;
}

export const ChatErrorDialog = ({
  isOpen,
  onOpenChange,
  error,
}: ChatErrorDialogProps) => {
  const [copied, setCopied] = useState(false);
  const message = error?.message || "An unknown error occurred.";

  const handleCopy = () => {
    navigator.clipboard.writeText(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Chat Error</DialogTitle>
          <DialogDescription>
            An error occurred while processing your request.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Error Details</AlertTitle>
            <AlertDescription className="break-all">{message}</AlertDescription>
          </Alert>
        </div>
        <DialogFooter className="flex-row justify-end">
          <Button
            variant="outline"
            size="icon"
            aria-label="Copy error details"
            onClick={handleCopy}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
          <Button onClick={() => onOpenChange(false)}>Ok</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
