import { A2aEndpointsList } from "@/components/a2a-endpoints-list";
import { A2aEndpointNotices } from "@/components/a2a-endpoint-notices";

const A2aEndpointsPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">A2A endpoints</h1>
      <p className="text-muted-foreground mb-4">
        Let agents and chat apps outside Platypus talk to an agent in this
        workspace over A2A. Each endpoint has its own address, and each client
        gets its own token.
      </p>
      <A2aEndpointNotices orgId={orgId} workspaceId={workspaceId} />
      <A2aEndpointsList orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
};

export default A2aEndpointsPage;
