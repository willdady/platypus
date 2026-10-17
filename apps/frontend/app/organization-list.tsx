"use client";

import { MAIN_CONTENT_ID } from "@/components/skip-link";
import type { Organization } from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { AlertCircle, Building, Plus } from "lucide-react";
import { PageSpinner } from "@/components/page-spinner";
import { useScopedList } from "@/hooks/use-scoped-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ProtectedRoute } from "@/components/protected-route";
import { Header } from "@/components/header";
import { EmptyCard } from "@/components/empty-card";
import { useAuth } from "@/components/auth-provider";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { appRoutes, orgRoutes } from "@/lib/routes";

export default function Home() {
  const { user, isAuthLoading: isAuthLoadingUser } = useAuth();
  const router = useRouter();

  const {
    results: organizations,
    error,
    isLoading,
  } = useScopedList<Organization>("organizations", {});

  // Redirect to first organization if available
  useEffect(() => {
    if (organizations.length > 0) {
      router.replace(orgRoutes(organizations[0].id).root);
    }
  }, [organizations, router]);

  if (isAuthLoadingUser || (user && isLoading)) {
    return <PageSpinner />;
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
          <main
            id={MAIN_CONTENT_ID}
            className="flex-1 flex flex-col items-center justify-center p-8"
          >
            <h1 className="sr-only">Organizations</h1>
            <EmptyCard
              icon={<Building />}
              title="No organizations yet"
              description="Get started by creating your first organization to manage your workspaces and agents."
              action={
                <Button asChild>
                  <Link href={appRoutes.createOrganization}>
                    <Plus /> Create organization
                  </Link>
                </Button>
              }
            />
          </main>
        </div>
      </ProtectedRoute>
    );
  }

  // Show loading while redirecting
  return <PageSpinner />;
}
