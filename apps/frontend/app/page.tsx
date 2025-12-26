"use client";

import type { Organisation } from "@platypus/schemas";
import { WorkspaceList } from "@/components/workspace-list";
import { Button } from "@/components/ui/button";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import Link from "next/link";
import { AlertCircle, Building, Plus, Settings } from "lucide-react";
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
import { useState, useEffect } from "react";

export default function Home() {
  const { user, isAuthLoading: isAuthLoadingUser } = useAuth();
  const backendUrl = useBackendUrl();
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);

  const { data, error, isLoading } = useSWR<{ results: Organisation[] }>(
    backendUrl && user ? joinUrl(backendUrl, "/organisations") : null,
    fetcher,
  );

  const organisations = data?.results || [];

  useEffect(() => {
    if (organisations.length > 0 && !selectedOrgId) {
      setSelectedOrgId(organisations[0].id);
    }
  }, [organisations, selectedOrgId]);

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
          <AlertDescription>Failed to load organisations</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (organisations.length === 0) {
    return (
      <ProtectedRoute>
        <div className="min-h-screen flex flex-col">
          <Header />
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <Empty className="border-none">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Building />
                </EmptyMedia>
                <EmptyTitle>No organisations found</EmptyTitle>
                <EmptyDescription>
                  Get started by creating your first organisation to manage your
                  workspaces and agents.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild className="w-full">
                  <Link href="/create">
                    <Plus className="h-4 w-4" /> Create Organisation
                  </Link>
                </Button>
              </EmptyContent>
            </Empty>
          </div>
        </div>
      </ProtectedRoute>
    );
  }

  const selectedOrg = organisations.find((org) => org.id === selectedOrgId);

  return (
    <ProtectedRoute>
      <SidebarProvider>
        <div className="h-screen flex flex-col w-full overflow-hidden">
          <Header />
          <div className="flex-1 flex flex-col items-center overflow-y-auto">
            <div className="flex flex-col md:flex-row w-full md:w-full lg:w-4/5 max-w-3xl py-8 px-4 md:px-0">
              {/* Left Column: Organisation Navigation */}
              <div className="w-full md:w-48 md:fixed md:top-16 pt-4 mb-8 md:mb-0">
                <SidebarContent>
                  <SidebarGroup>
                    <SidebarGroupContent>
                      <SidebarMenu>
                        {organisations.map((org) => (
                          <SidebarMenuItem key={org.id}>
                            <SidebarMenuButton
                              isActive={selectedOrgId === org.id}
                              onClick={() => setSelectedOrgId(org.id)}
                            >
                              <Building className="size-4" />
                              <span>{org.name}</span>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        ))}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </SidebarGroup>

                  <SidebarGroup>
                    <SidebarGroupContent>
                      <SidebarMenu>
                        <SidebarMenuItem>
                          <SidebarMenuButton asChild>
                            <Link href="/create">
                              <Plus className="size-4" />
                              <span>Add Organisation</span>
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </SidebarGroup>
                </SidebarContent>
              </div>

              {/* Right Column: Workspace List */}
              <div className="flex-1 p-2 md:ml-48">
                {selectedOrg ? (
                  <div className="space-y-8">
                    <div>
                      <h2 className="text-2xl font-bold flex items-center gap-2">
                        {selectedOrg.name}
                      </h2>
                      <p className="text-muted-foreground">
                        Manage workspaces for this organisation.
                      </p>
                    </div>

                    <div className="space-y-4">
                      <WorkspaceList orgId={selectedOrg.id} />
                      <div className="flex items-center gap-2">
                        <Button asChild>
                          <Link href={`/${selectedOrg.id}/create`}>
                            <Plus className="size-4" /> Add workspace
                          </Link>
                        </Button>
                        <Button variant="outline" asChild>
                          <Link href={`/${selectedOrg.id}/settings`}>
                            <Settings className="size-4" /> Org settings
                          </Link>
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-64">
                    <p className="text-muted-foreground">
                      Select an organisation from the menu.
                    </p>
                  </div>
                )}
              </div>
            </div>
            <div className="h-1 shrink-0" />
          </div>
        </div>
      </SidebarProvider>
    </ProtectedRoute>
  );
}
