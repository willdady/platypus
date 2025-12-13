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
import { TriangleAlert } from "lucide-react";

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
            <AlertDescription>
              {error?.message || "An unknown error occurred."}
            </AlertDescription>
          </Alert>
        </div>
        <DialogFooter>
          <Button
            className="cursor-pointer"
            onClick={() => onOpenChange(false)}
          >
            Ok
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
