import { WorkspaceForm } from "@/components/workspace-form";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

const WorkspaceCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <div className="flex justify-center w-full p-4">
      <div className="w-lg">
        <Button className="mb-8" variant="outline" size="sm" asChild>
          <Link href={`/${orgId}`}>
            <ArrowLeft /> Back
          </Link>
        </Button>
        <h1 className="text-2xl mb-4 font-bold">Create Workspace</h1>
        <WorkspaceForm orgId={orgId} />
      </div>
    </div>
  );
};

export default WorkspaceCreatePage;
