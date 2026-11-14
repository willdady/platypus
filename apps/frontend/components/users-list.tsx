"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/format-date";
import { Badge } from "@/components/ui/badge";
import { Shield, KeyRound } from "lucide-react";
import { useState } from "react";
import { useAuth, type User } from "@/components/auth-provider";
import { joinUrl } from "@/lib/utils";
import { writeAt, type Serialized } from "@/lib/api-write";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { toast } from "sonner";
import { ChangePasswordDialog } from "@/components/change-password-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ListState } from "@/components/list-state";
import {
  BadgeSkeleton,
  IconButtonSkeleton,
  SkeletonLine,
  TableSkeleton,
  UserCellSkeleton,
} from "@/components/list-skeletons";
import { TableList } from "@/components/table-list";
import { RowActionsMenu } from "@/components/row-actions-menu";
import { UserCell } from "@/components/user-cell";

/** A row of `list-users`, read as plain JSON rather than through the auth client. */
export type ListedUser = Serialized<User>;

type ListUsersResponse = {
  users: ListedUser[];
};

export function UsersList() {
  const { user: currentUser } = useAuth();
  const [changingPasswordUser, setChangingPasswordUser] =
    useState<ListedUser | null>(null);

  const { data, error, isLoading, mutate } = useScopedSWR<ListUsersResponse>(
    "auth/admin/list-users",
    {},
  );

  const deleteFlow = useDeleteFlow<ListedUser>({
    mutate,
    delete: (target, url) =>
      writeAt(joinUrl(url, "/auth/admin/remove-user"), {
        method: "POST",
        data: { userId: target.id },
        // better-auth's admin actions echo the browser's Origin.
        headers: { Origin: window.location.origin },
      }),
    onSuccess: (target) => {
      toast.success(`User ${target.name} has been deleted`);
    },
  });

  const users = data?.users || [];

  return (
    <>
      <TableList
        isLoading={isLoading}
        data={data}
        error={error}
        subject="users"
        skeleton={
          <TableSkeleton
            tableClassName="min-w-[800px]"
            columns={[
              { header: "User", cell: <UserCellSkeleton /> },
              { header: "Role", cell: <BadgeSkeleton className="w-14" /> },
              { header: "Status", cell: <BadgeSkeleton /> },
              { header: "Created", cell: <SkeletonLine className="w-20" /> },
              {
                header: "Actions",
                className: "text-right",
                // The row's ⋮ menu.
                cell: (
                  <div className="flex justify-end">
                    <IconButtonSkeleton />
                  </div>
                ),
              },
            ]}
          />
        }
        empty={<ListState variant="empty">No users found.</ListState>}
        isEmpty={users.length === 0}
        onRetry={() => void mutate()}
      >
        <Table bordered className="min-w-[800px]">
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => {
              const manageable =
                user.id !== currentUser?.id && user.role !== "admin";
              return (
                <TableRow key={user.id}>
                  <TableCell>
                    <UserCell name={user.name} email={user.email} />
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={user.role === "admin" ? "default" : "secondary"}
                      className="capitalize"
                    >
                      {user.role === "admin" && <Shield className="size-3" />}
                      {user.role === "admin" ? "Super Admin" : "User"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {user.banned ? (
                        <Badge variant="destructive">Banned</Badge>
                      ) : user.emailVerified ? (
                        <Badge variant="outline" className="text-success">
                          Verified
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-warning-foreground"
                        >
                          Unverified
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground">
                      {formatDate(user.createdAt)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActionsMenu
                      name={user.name}
                      actions={
                        manageable
                          ? [
                              {
                                label: "Change password",
                                icon: <KeyRound />,
                                onSelect: () => setChangingPasswordUser(user),
                              },
                            ]
                          : []
                      }
                      remove={
                        manageable
                          ? { onSelect: () => deleteFlow.request(user) }
                          : undefined
                      }
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableList>

      {changingPasswordUser && (
        <ChangePasswordDialog
          user={changingPasswordUser}
          open={!!changingPasswordUser}
          onOpenChange={(open) => !open && setChangingPasswordUser(null)}
          onSuccess={() => {
            setChangingPasswordUser(null);
            void mutate();
          }}
        />
      )}

      {deleteFlow.target && (
        <DeleteConfirmDialog
          noun="user"
          name={deleteFlow.target.name}
          consequence={
            <>
              Their email is {deleteFlow.target.email}, and all of their data is
              removed from the system.
            </>
          }
          requireTypedConfirmation
          confirmLabel="Delete user"
          {...deleteFlow.dialogProps}
        />
      )}
    </>
  );
}
