import { ProtectedRoute } from "@/components/protected-route";

export default function OrgLayout({ children }: { children: React.ReactNode }) {
  return <ProtectedRoute requireOrgAccess>{children}</ProtectedRoute>;
}
