"use client";

import { ProtectedRoute } from "@/components/protected-route";
import { UsersList } from "@/components/users-list";

export default function UsersPage() {
  return (
    <ProtectedRoute requireSuperAdmin={true}>
      <div>
        <h1 className="text-2xl font-bold mb-4">User Management</h1>
        <p className="text-muted-foreground mb-6">
          Manage all users in the system, including password changes.
        </p>
        <UsersList />
      </div>
    </ProtectedRoute>
  );
}
