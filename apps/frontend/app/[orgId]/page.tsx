import type { Organisation } from "@agent-kit/schemas";
import { WorkspaceList } from "@/components/workspace-list";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Building, Plus } from "lucide-react";

const Org = async ({ params }: { params: Promise<{ orgId: string }> }) => {
  const { orgId } = await params;

  // Use internal URL for SSR, fallback to BACKEND_URL for local dev
  const backendUrl = process.env.INTERNAL_BACKEND_URL || process.env.BACKEND_URL;
  const response = await fetch(`${backendUrl}/organisations/${orgId}`);

  if (response.status === 404) {
    notFound();
  }

  const organisation: Organisation = await response.json();

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-bold mb-4 flex items-center gap-1">
          <Building className="inline-block" /> {organisation.name}
        </h1>
        <WorkspaceList orgId={orgId} />
        <div className="mt-4">
          <Button asChild>
            <Link href={`/${orgId}/create`}>
              <Plus /> Add workspace
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
};

export default Org;
