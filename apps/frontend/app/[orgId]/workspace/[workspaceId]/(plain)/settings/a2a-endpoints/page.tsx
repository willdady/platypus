import type { Metadata } from "next";
import { TriangleAlert } from "lucide-react";
import { A2aEndpointsList } from "@/components/a2a-endpoints-list";
import { A2aEndpointNotices } from "@/components/a2a-endpoint-notices";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "A2A endpoints" };

async function A2aEndpointsPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <PageHeader
        title="A2A endpoints"
        description="Let agents and chat apps outside Platypus talk to an agent in this workspace over A2A. Each endpoint has its own address, and each client gets its own token."
      />
      <Alert className="mb-6">
        <TriangleAlert />
        <AlertTitle>
          Runs act as you, with all of the agent&apos;s tools
        </AlertTitle>
        <AlertDescription>
          Anyone holding a token can talk to the agent, and every run acts as
          you with every tool the agent has. Only expose an agent whose tools
          are safe for the people you give tokens to.
        </AlertDescription>
      </Alert>
      <A2aEndpointNotices orgId={orgId} workspaceId={workspaceId} />
      <A2aEndpointsList orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
}

export default A2aEndpointsPage;
