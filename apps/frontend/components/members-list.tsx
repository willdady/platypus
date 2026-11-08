"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { MoreHorizontal, Shield, Trash2, Edit } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { type OrgMemberListItem } from "@platypus/schemas";
import { useState } from "react";
import { MemberEditDialog } from "@/components/member-edit-dialog";
import { RemoveMemberDialog } from "@/components/remove-member-dialog";
import type { Serialized } from "@/lib/api-write";
import { UserCell } from "@/components/user-cell";

type MembersListProps = {
  orgId: string;
  members: Serialized<OrgMemberListItem>[];
  onUpdate: () => void;
};

export function MembersList({ orgId, members, onUpdate }: MembersListProps) {
  const [editingMember, setEditingMember] =
    useState<Serialized<OrgMemberListItem> | null>(null);
  const [removingMember, setRemovingMember] =
    useState<Serialized<OrgMemberListItem> | null>(null);

  return (
    <>
      <Table bordered className="min-w-[600px]">
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Org Role</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => (
            <TableRow key={member.id}>
              <TableCell>
                <UserCell
                  name={member.user.name}
                  email={member.user.email}
                  image={member.user.image}
                />
              </TableCell>
              <TableCell>
                <Badge
                  variant={
                    member.isSuperAdmin
                      ? "default"
                      : member.role === "admin"
                        ? "default"
                        : "secondary"
                  }
                  className="capitalize"
                >
                  {member.isSuperAdmin && <Shield />}
                  {member.isSuperAdmin ? "Super Admin" : member.role}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Actions for ${member.user.name}`}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel>Actions</DropdownMenuLabel>
                    {!member.isSuperAdmin && (
                      <>
                        <DropdownMenuItem
                          onClick={() => setEditingMember(member)}
                        >
                          <Edit className="size-4" /> Edit org role
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => setRemovingMember(member)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="size-4" /> Remove from Org
                        </DropdownMenuItem>
                      </>
                    )}
                    {member.isSuperAdmin && (
                      <DropdownMenuItem
                        disabled
                        className="text-muted-foreground"
                      >
                        <Shield /> Super Admin - No actions available
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {editingMember && (
        <MemberEditDialog
          orgId={orgId}
          member={editingMember}
          open={!!editingMember}
          onOpenChange={(open: boolean) => !open && setEditingMember(null)}
          onSuccess={() => {
            setEditingMember(null);
            onUpdate();
          }}
        />
      )}

      {removingMember && (
        <RemoveMemberDialog
          orgId={orgId}
          member={removingMember}
          members={members}
          open={!!removingMember}
          onOpenChange={(open: boolean) => !open && setRemovingMember(null)}
          onSuccess={() => {
            setRemovingMember(null);
            onUpdate();
          }}
        />
      )}
    </>
  );
}
