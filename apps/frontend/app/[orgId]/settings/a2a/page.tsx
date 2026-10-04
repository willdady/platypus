import { OrgA2aAccess } from "@/components/org-gate-access";
import { OrgA2aEndpointsList } from "@/components/org-a2a-endpoints-list";

const OrgA2aPage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">A2A endpoints</h1>
      <p className="text-muted-foreground mb-6">
        A2A endpoints let agents and chat apps outside Platypus talk to an agent
        in a workspace. Decide here which workspaces can have them. Workspace
        owners create the endpoints and their tokens. You can revoke an endpoint
        or a token to stop its calls straight away.
      </p>

      <h2 className="text-lg font-semibold mb-3">Access</h2>
      <div className="mb-8">
        <OrgA2aAccess orgId={orgId} />
      </div>

      <h2 className="text-lg font-semibold mb-3">Endpoints</h2>
      <OrgA2aEndpointsList orgId={orgId} />
    </div>
  );
};

export default OrgA2aPage;
