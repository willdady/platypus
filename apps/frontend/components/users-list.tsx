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
import { Badge } from "@/components/ui/badge";
import { Shield, User as UserIcon, KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { joinUrl } from "@/lib/utils";
import useSWR from "swr";
import { fetcher } from "@/lib/utils";
import { ChangePasswordDialog } from "@/components/change-password-dialog";
import { DeleteUserDialog } from "@/components/delete-user-dialog";

interface User {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
  emailVerified: boolean;
  banned?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ListUsersResponse {
  users: User[];
}

export function UsersList() {
  const backendUrl = useBackendUrl();
  const { user: currentUser } = useAuth();
  const [changingPasswordUser, setChangingPasswordUser] = useState<User | null>(
    null,
  );
  const [deletingUser, setDeletingUser] = useState<User | null>(null);

  const { data, error, isLoading, mutate } = useSWR<ListUsersResponse>(
    joinUrl(backendUrl, "/auth/admin/list-users"),
    fetcher,
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-muted-foreground">Loading users...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-destructive">
          Failed to load users. {error.info?.message || error.message}
        </p>
      </div>
    );
  }

  const users = data?.users || [];

  if (users.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-muted-foreground">No users found.</p>
      </div>
    );
  }

  return (
    <>
      <div className="border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <Table className="min-w-[800px]">
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
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center overflow-hidden">
                        <UserIcon className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="flex flex-col">
                        <span className="font-medium">{user.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {user.email}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={user.role === "admin" ? "default" : "secondary"}
                      className="capitalize"
                    >
                      {user.role === "admin" && <Shield className="h-3 w-3" />}
                      {user.role === "admin" ? "Super Admin" : "User"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {user.banned ? (
                        <Badge variant="destructive">Banned</Badge>
                      ) : user.emailVerified ? (
                        <Badge variant="outline" className="text-green-600">
                          Verified
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-yellow-600">
                          Unverified
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground">
                      {new Date(user.createdAt).toLocaleDateString()}
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
                            className="cursor-pointer"
                          >
                            <KeyRound className="h-4 w-4" />
                            Change Password
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setDeletingUser(user)}
                            className="cursor-pointer"
                          >
                            <Trash2 className="h-4 w-4" />
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
        </div>
      </div>

      {changingPasswordUser && (
        <ChangePasswordDialog
          user={changingPasswordUser}
          open={!!changingPasswordUser}
          onOpenChange={(open) => !open && setChangingPasswordUser(null)}
          onSuccess={() => {
            setChangingPasswordUser(null);
            mutate();
          }}
        />
      )}

      {deletingUser && (
        <DeleteUserDialog
          user={deletingUser}
          open={!!deletingUser}
          onOpenChange={(open) => !open && setDeletingUser(null)}
          onSuccess={() => {
            setDeletingUser(null);
            mutate();
          }}
        />
      )}
    </>
  );
}
