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
import { writeAt } from "@/lib/api-write";
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
      const outcome = await writeAt(
        joinUrl(backendUrl, `/organizations/${orgId}/members/${member.id}`),
        { method: "PATCH", data: { role } },
      );
      if (outcome.outcome === "success") {
        toast.success("Member role updated");
        onSuccess();
      } else {
        toast.error(outcome.message);
      }
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
            Change the organization-level role for {member.user.name}.
          </DialogDescription>
        </DialogHeader>

        <FieldSet>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="role">Organization Role</FieldLabel>
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
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || role === member.role}
            className={isSubmitting ? "opacity-50" : ""}
          >
            {isSubmitting ? "Saving..." : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
