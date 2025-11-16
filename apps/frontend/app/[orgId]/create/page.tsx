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
    <div>
      <Button className="mb-8" variant="outline" size="sm" asChild>
        <Link href={`/${orgId}`}>
          <ArrowLeft /> Back
        </Link>
      </Button>
      <h1 className="text-2xl mb-4 font-bold">Create Workspace</h1>
      <WorkspaceForm orgId={orgId} />
    </div>
  );
};

export default WorkspaceCreatePage;
