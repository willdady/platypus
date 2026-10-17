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
import { MoreHorizontal, Shield, User, Trash2, Edit } from "lucide-react";
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
                <div className="flex items-center gap-3">
                  <div className="size-8 rounded-full bg-muted flex items-center justify-center overflow-hidden">
                    {member.user.image ? (
                      // Avatar URL comes from an arbitrary OAuth/external
                      // host; not routable through the Next image optimizer.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={member.user.image}
                        alt={member.user.name}
                        className="size-full object-cover"
                        width={32}
                        height={32}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <User className="size-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex flex-col">
                    <span className="font-medium">{member.user.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {member.user.email}
                    </span>
                  </div>
                </div>
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
                  {member.isSuperAdmin && <Shield className="size-3" />}
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
                        <Shield className="size-3" /> Super Admin - No actions
                        available
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
