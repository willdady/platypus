"use client";

import type { Organisation } from "@platypus/schemas";
import { WorkspaceList } from "@/components/workspace-list";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import Link from "next/link";
import { Building, Plus, Settings } from "lucide-react";
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
  const defaultOrgId =
    organisations.length === 1 ? organisations[0].id : undefined;

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8">
      <div className="w-full max-w-md space-y-12">
        <Accordion
          type="single"
          collapsible
          className="w-full"
          defaultValue={defaultOrgId}
        >
          {organisations.map((organisation) => (
            <AccordionItem key={organisation.id} value={organisation.id}>
              <AccordionTrigger className="hover:no-underline">
                <div className="text-lg font-semibold flex items-center gap-2">
                  <Building className="size-5" /> {organisation.name}
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <WorkspaceList orgId={organisation.id} />
                <div className="mt-4 flex items-center gap-2">
                  <Button asChild>
                    <Link href={`/${organisation.id}/create`}>
                      <Plus /> Add workspace
                    </Link>
                  </Button>
                  <Button variant="outline" asChild>
                    <Link href={`/${organisation.id}/edit`}>
                      <Settings className="h-4 w-4" /> Org settings
                    </Link>
                  </Button>
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>

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
