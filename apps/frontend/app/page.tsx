import type { Organisation } from "@agent-kit/schemas";
import { WorkspaceList } from "@/components/workspace-list";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Building, Plus } from "lucide-react";

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
            <h1 className="text-2xl font-bold mb-4 flex items-center gap-1">
              <Building className="inline-block" /> {organisation.name}
            </h1>
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
          <Button variant="outline" className="w-full">
            <Plus /> Add Organisation
          </Button>
        </div>
      </div>
    </div>
  );
}
