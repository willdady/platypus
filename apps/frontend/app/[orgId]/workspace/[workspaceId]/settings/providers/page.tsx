import { ProvidersList } from "@/components/providers-list";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";

const ProvidersPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <ProvidersList orgId={orgId} workspaceId={workspaceId} />
      <Button asChild>
        <Link
          href={`/${orgId}/workspace/${workspaceId}/settings/providers/create`}
        >
          <Plus /> Add provider
        </Link>
      </Button>
    </div>
  );
};

export default ProvidersPage;
