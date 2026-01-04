"use client";

import type { Organization } from "@platypus/schemas";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { AlertCircle, Building, Plus } from "lucide-react";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "./client-context";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ProtectedRoute } from "@/components/protected-route";
import { Header } from "@/components/header";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useAuth } from "@/components/auth-provider";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const { user, isAuthLoading: isAuthLoadingUser } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();

  const { data, error, isLoading } = useSWR<{ results: Organization[] }>(
    backendUrl && user ? joinUrl(backendUrl, "/organizations") : null,
    fetcher,
  );

  const organizations = data?.results || [];

  // Redirect to first organization if available
  useEffect(() => {
    if (organizations.length > 0) {
      router.replace(`/${organizations[0].id}`);
    }
  }, [organizations, router]);

  if (!backendUrl) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-8">
        <Alert variant="destructive" className="max-w-md">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Configuration Error</AlertTitle>
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
          <AlertCircle className="h-4 w-4" />
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
            <Empty className="border-2 border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Building />
                </EmptyMedia>
                <EmptyTitle>No organizations found</EmptyTitle>
                <EmptyDescription>
                  Get started by creating your first organization to manage your
                  workspaces and agents.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild className="w-full">
                  <Link href="/create">
                    <Plus className="h-4 w-4" /> Create Organization
                  </Link>
                </Button>
              </EmptyContent>
            </Empty>
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
