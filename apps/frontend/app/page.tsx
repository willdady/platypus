"use client";

import type { Organization } from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { AlertCircle, Building, Plus } from "lucide-react";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ProtectedRoute } from "@/components/protected-route";
import { Header } from "@/components/header";
import { EmptyCard } from "@/components/empty-card";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { orgRoutes } from "@/lib/routes";

export default function Home() {
  const { user, isAuthLoading: isAuthLoadingUser } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();

  const { data, error, isLoading } = useScopedSWR<{
    results: Organization[];
  }>("organizations", {});

  const organizations = useMemo(() => data?.results || [], [data]);

  // Redirect to first organization if available
  useEffect(() => {
    if (organizations.length > 0) {
      router.replace(orgRoutes(organizations[0].id).root);
    }
  }, [organizations, router]);

  if (!backendUrl) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-8">
        <Alert variant="destructive" className="max-w-md">
          <AlertCircle />
          <AlertTitle>Configuration error</AlertTitle>
          <AlertDescription>
            The <code>BACKEND_URL</code> environment variable is not set.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (isAuthLoadingUser || (user && isLoading)) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-8">
        <Alert variant="destructive" className="max-w-md">
          <AlertCircle />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>Failed to load organizations</AlertDescription>
        </Alert>
      </div>
    );
  }

  // Only show empty state if no organizations
  if (organizations.length === 0) {
    return (
      <ProtectedRoute>
        <div className="min-h-screen flex flex-col">
          <Header />
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <EmptyCard
              icon={<Building />}
              title="No organizations found"
              description="Get started by creating your first organization to manage your workspaces and agents."
              action={
                <Button asChild>
                  <Link href="/create">
                    <Plus /> Create organization
                  </Link>
                </Button>
              }
            />
          </div>
        </div>
      </ProtectedRoute>
    );
  }

  // Show loading while redirecting
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
    </div>
  );
}
