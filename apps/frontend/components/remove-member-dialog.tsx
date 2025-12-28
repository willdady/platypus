"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { type OrgMemberListItem } from "@platypus/schemas";
import { useBackendUrl } from "@/app/client-context";
import { joinUrl } from "@/lib/utils";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";

interface RemoveMemberDialogProps {
  orgId: string;
  member: OrgMemberListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function RemoveMemberDialog({
  orgId,
  member,
  open,
  onOpenChange,
  onSuccess,
}: RemoveMemberDialogProps) {
  const backendUrl = useBackendUrl();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const response = await fetch(
        joinUrl(backendUrl, `/organizations/${orgId}/members/${member.id}`),
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (response.ok) {
        toast.success("Member removed from organization");
        onSuccess();
      } else {
        const data = await response.json();
        toast.error(data.error || data.message || "Failed to remove member");
      }
    } catch (error) {
      toast.error("Error removing member");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Remove Member
          </DialogTitle>
          <DialogDescription>
            Are you sure you want to remove <strong>{member.user.name}</strong>{" "}
            from this organization?
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <p className="text-sm text-muted-foreground">
            This will immediately revoke their access to all workspaces in this
            organization:
          </p>
          <ul className="mt-2 space-y-1">
            {member.workspaces.map((ws) => (
              <li
                key={ws.workspaceId}
                className="text-sm font-medium flex items-center gap-2"
              >
                <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
                {ws.workspaceName}
              </li>
            ))}
            {member.workspaces.length === 0 && (
              <li className="text-sm text-muted-foreground italic">
                No workspaces assigned
              </li>
            )}
          </ul>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
            className="cursor-pointer"
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="cursor-pointer"
          >
            {isSubmitting ? "Removing..." : "Remove Member"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
