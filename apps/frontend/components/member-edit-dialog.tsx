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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field, FieldLabel, FieldGroup, FieldSet } from "@/components/ui/field";
import { useState } from "react";
import { type OrgMemberListItem } from "@platypus/schemas";
import { useBackendUrl } from "@/app/client-context";
import { joinUrl } from "@/lib/utils";
import { toast } from "sonner";

interface MemberEditDialogProps {
  orgId: string;
  member: OrgMemberListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function MemberEditDialog({
  orgId,
  member,
  open,
  onOpenChange,
  onSuccess,
}: MemberEditDialogProps) {
  const backendUrl = useBackendUrl();
  const [role, setRole] = useState<string>(member.role);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const response = await fetch(
        joinUrl(backendUrl, `/organisations/${orgId}/members/${member.id}`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
          credentials: "include",
        },
      );

      if (response.ok) {
        toast.success("Member role updated");
        onSuccess();
      } else {
        const data = await response.json();
        toast.error(
          data.error || data.message || "Failed to update member role",
        );
      }
    } catch (error) {
      toast.error("Error updating member role");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Member Role</DialogTitle>
          <DialogDescription>
            Change the organisation-level role for {member.user.name}.
          </DialogDescription>
        </DialogHeader>

        <FieldSet>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="role">Organisation Role</FieldLabel>
              <Select
                value={role}
                onValueChange={setRole}
                disabled={isSubmitting}
              >
                <SelectTrigger id="role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="member">Member</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
        </FieldSet>

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
            onClick={handleSubmit}
            disabled={isSubmitting || role === member.role}
            className={`cursor-pointer ${isSubmitting ? "opacity-50" : ""}`}
          >
            {isSubmitting ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
