"use client";

import type { Organisation } from "@agent-kit/schemas";
import { WorkspaceList } from "@/components/workspace-list";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Building, Plus, Pencil } from "lucide-react";
import useSWR from "swr";
import { fetcher } from "@/lib/utils";
import { useBackendUrl } from "./client-context";

export default function Home() {
  const backendUrl = useBackendUrl();
  const { data, error, isLoading } = useSWR<{ results: Organisation[] }>(
    `${backendUrl}/organisations`,
    fetcher,
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-8">
        <div className="text-red-500 mb-4">Failed to load organisations</div>
        <Button onClick={() => window.location.reload()}>Retry</Button>
      </div>
    );
  }

  const organisations = data?.results || [];

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8">
      <div className="w-full max-w-md space-y-12">
        {organisations.map((organisation) => (
          <div key={organisation.id}>
            <div className="flex items-center justify-between mb-4">
              <h1 className="text-2xl font-bold flex items-center gap-1">
                <Building className="inline-block" /> {organisation.name}
              </h1>
              <Button variant="ghost" size="icon" asChild>
                <Link href={`/${organisation.id}/edit`}>
                  <Pencil className="h-4 w-4" />
                </Link>
              </Button>
            </div>
            <WorkspaceList orgId={organisation.id} />
            <div className="mt-4">
              <Button asChild>
                <Link href={`/${organisation.id}/create`}>
                  <Plus /> Add workspace
                </Link>
              </Button>
            </div>
          </div>
        ))}

        <div className="pt-8 border-t">
          <Button variant="outline" className="w-full" asChild>
            <Link href="/create">
              <Plus /> Add Organisation
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
