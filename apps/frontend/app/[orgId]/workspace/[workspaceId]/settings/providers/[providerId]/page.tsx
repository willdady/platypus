import { ProviderForm } from "@/components/provider-form";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

const ProviderEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; providerId: string }>;
}) => {
  const { orgId, workspaceId, providerId } = await params;

  return (
    <div>
      <Button className="mb-8" variant="outline" size="sm" asChild>
        <Link href={`/${orgId}/workspace/${workspaceId}/settings/providers`}>
          <ArrowLeft /> Back
        </Link>
      </Button>
      <h1 className="text-2xl mb-4 font-bold">Edit Provider</h1>
      <ProviderForm
        orgId={orgId}
        workspaceId={workspaceId}
        providerId={providerId}
      />
    </div>
  );
};

export default ProviderEditPage;
