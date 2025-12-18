import type { Organisation } from "@agent-kit/schemas";
import { WorkspaceList } from "@/components/workspace-list";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Building, Plus, Pencil } from "lucide-react";

export default async function Home() {
  // Use internal URL for SSR, fallback to BACKEND_URL for local dev
  const backendUrl =
    process.env.INTERNAL_BACKEND_URL || process.env.BACKEND_URL;
  const response = await fetch(`${backendUrl}/organisations`);

  const { results: organisations }: { results: Organisation[] } =
    await response.json();

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
