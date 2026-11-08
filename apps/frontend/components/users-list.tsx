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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Shield, KeyRound, Trash2 } from "lucide-react";
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
  SkeletonLine,
  TableSkeleton,
  UserCellSkeleton,
} from "@/components/list-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { TableList } from "@/components/table-list";
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
                // Change password + Delete, both `size="sm"`.
                cell: (
                  <div className="flex items-center justify-end gap-2">
                    <Skeleton className="h-8 w-40" />
                    <Skeleton className="h-8 w-20" />
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
            {users.map((user) => (
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
                  <div className="flex items-center justify-end gap-2">
                    {user.id !== currentUser?.id && user.role !== "admin" && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setChangingPasswordUser(user)}
                        >
                          <KeyRound />
                          Change password
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => deleteFlow.request(user)}
                        >
                          <Trash2 />
                          Delete
                        </Button>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
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
          open={deleteFlow.open}
          onOpenChange={(open) => !open && deleteFlow.close()}
          title="Delete User"
          description={
            <>
              This action cannot be undone. This will permanently delete the
              user{" "}
              <span className="font-semibold">{deleteFlow.target.name}</span> (
              {deleteFlow.target.email}) and remove all of their data from the
              system.
            </>
          }
          confirmLabel="Delete user"
          confirmPhrase="delete user"
          onConfirm={deleteFlow.confirm}
          loading={deleteFlow.deleting}
          error={deleteFlow.error}
        />
      )}
    </>
  );
}
