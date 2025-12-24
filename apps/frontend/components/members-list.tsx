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
import {
  MoreHorizontal,
  Shield,
  User,
  Trash2,
  Layout,
  Edit,
  Lock,
  Infinity,
} from "lucide-react";
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
import { WorkspaceAccessDialog } from "@/components/workspace-access-dialog";
import { RemoveMemberDialog } from "@/components/remove-member-dialog";

interface MembersListProps {
  orgId: string;
  members: OrgMemberListItem[];
  onUpdate: () => void;
}

export function MembersList({ orgId, members, onUpdate }: MembersListProps) {
  const [editingMember, setEditingMember] = useState<OrgMemberListItem | null>(
    null,
  );
  const [managingAccess, setManagingAccess] =
    useState<OrgMemberListItem | null>(null);
  const [removingMember, setRemovingMember] =
    useState<OrgMemberListItem | null>(null);

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <Table className="min-w-[800px]">
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Org Role</TableHead>
              <TableHead>Workspaces</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center overflow-hidden">
                      {member.user.image ? (
                        <img
                          src={member.user.image}
                          alt={member.user.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <User className="h-4 w-4 text-muted-foreground" />
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
                    {member.isSuperAdmin && <Shield className="h-3 w-3" />}
                    {member.isSuperAdmin ? "Super Admin" : member.role}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    {member.isSuperAdmin ? (
                      <>
                        <Infinity className="h-4 w-4 text-muted-foreground" />
                        <span>All Workspaces</span>
                      </>
                    ) : (
                      <>
                        <Layout className="h-4 w-4 text-muted-foreground" />
                        <span>{member.workspaces.length}</span>
                      </>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="cursor-pointer"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>Actions</DropdownMenuLabel>
                      {!member.isSuperAdmin && (
                        <>
                          <DropdownMenuItem
                            onClick={() => setEditingMember(member)}
                            className="cursor-pointer"
                          >
                            <Edit className="h-4 w-4" /> Edit Org Role
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => setManagingAccess(member)}
                            className="cursor-pointer"
                          >
                            <Lock className="h-4 w-4" /> Manage Workspace Access
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => setRemovingMember(member)}
                            className="text-destructive focus:text-destructive cursor-pointer"
                          >
                            <Trash2 className="h-4 w-4" /> Remove from Org
                          </DropdownMenuItem>
                        </>
                      )}
                      {member.isSuperAdmin && (
                        <DropdownMenuItem
                          disabled
                          className="text-muted-foreground"
                        >
                          <Shield className="h-3 w-3" /> Super Admin - No
                          actions available
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

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

      {managingAccess && (
        <WorkspaceAccessDialog
          orgId={orgId}
          member={managingAccess}
          open={!!managingAccess}
          onOpenChange={(open: boolean) => !open && setManagingAccess(null)}
          onSuccess={() => {
            setManagingAccess(null);
            onUpdate();
          }}
        />
      )}

      {removingMember && (
        <RemoveMemberDialog
          orgId={orgId}
          member={removingMember}
          open={!!removingMember}
          onOpenChange={(open: boolean) => !open && setRemovingMember(null)}
          onSuccess={() => {
            setRemovingMember(null);
            onUpdate();
          }}
        />
      )}
    </div>
  );
}
