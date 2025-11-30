import { AgentForm } from "@/components/agent-form";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { type ToolSet } from "@agent-kit/schemas";

const AgentEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; agentId: string }>;
}) => {
  const { orgId, workspaceId, agentId } = await params;

  // Use internal URL for SSR, fallback to BACKEND_URL for local dev
  const backendUrl = process.env.INTERNAL_BACKEND_URL || process.env.BACKEND_URL;

  // Fetch tool sets from the server
  const [toolSetsResponse] = await Promise.all([fetch(`${backendUrl}/tools`)]);

  const toolSetsData = await toolSetsResponse.json();
  const toolSets: ToolSet[] = toolSetsData.results;

  return (
    <div className="flex justify-center pb-8">
      <div className="xl:w-2/5">
        <Button className="mb-8" variant="outline" size="sm" asChild>
          <Link href={`/${orgId}/workspace/${workspaceId}/agents`}>
            <ArrowLeft /> Back
          </Link>
        </Button>
        <h1 className="text-2xl mb-4 font-bold">Edit Agent</h1>
        <AgentForm
          orgId={orgId}
          workspaceId={workspaceId}
          agentId={agentId}
          toolSets={toolSets}
        />
      </div>
    </div>
  );
};

export default AgentEditPage;
