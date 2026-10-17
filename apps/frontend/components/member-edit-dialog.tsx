"use client";

import { toast } from "sonner";
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
import { type OrgMemberListItem } from "@platypus/schemas";
import { useBackendUrl } from "@/components/auth-provider";
import { joinUrl } from "@/lib/utils";
import { writeAt, type Serialized } from "@/lib/api-write";
import { useEntityForm } from "@/hooks/use-entity-form";

type MemberEditDialogProps = {
  orgId: string;
  member: Serialized<OrgMemberListItem>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
};

export function MemberEditDialog({
  orgId,
  member,
  open,
  onOpenChange,
  onSuccess,
}: MemberEditDialogProps) {
  const backendUrl = useBackendUrl();
  const { formData, setField, isSubmitting, submit } = useEntityForm({
    initialData: { role: member.role as string },
    guardUnsavedChanges: false,
    entity: "members",
    scope: { orgId },
    write: (data) =>
      writeAt(
        joinUrl(backendUrl, `/organizations/${orgId}/members/${member.id}`),
        { method: "PATCH", data },
      ),
    // No field here renders a server error, so a rejection is toasted.
    onInvalid: (_fieldErrors, message) => toast.error(message),
    successMessage: "Member role updated",
    onSuccess,
  });
  const role = formData.role;

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
                onValueChange={(value) => setField("role", value)}
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
            onClick={() => submit()}
            disabled={isSubmitting || role === member.role}
            className={isSubmitting ? "opacity-50" : ""}
          >
            {isSubmitting ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
