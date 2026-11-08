import type { Metadata } from "next";
import { ProtectedRoute } from "@/components/protected-route";
import { UsersList } from "@/components/users-list";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "User Management" };

export default function UsersPage() {
  return (
    <ProtectedRoute requireSuperAdmin>
      <div>
        <PageHeader
          title="User Management"
          description="Manage all users in the system, including password changes."
        />
        <UsersList />
      </div>
    </ProtectedRoute>
  );
}
