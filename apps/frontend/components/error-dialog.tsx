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

interface ErrorDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  error: any;
}

export const ErrorDialog = ({
  isOpen,
  onOpenChange,
  error,
}: ErrorDialogProps) => {
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
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        </div>
        <DialogFooter>
          <Button variant="outline" size="icon" onClick={handleCopy}>
            {copied ? <Check /> : <Copy />}
          </Button>
          <Button onClick={() => onOpenChange(false)}>Ok</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
