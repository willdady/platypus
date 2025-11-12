import { ProvidersList } from "@/components/providers-list";
import { Button } from "@/components/ui/button";
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
          Add provider
        </Link>
      </Button>
    </div>
  );
};

export default ProvidersPage;
