import { AgentForm } from "@/components/agent-form";
import { headers } from "next/headers";
import { BackButton } from "@/components/back-button";
import { type ToolSet } from "@platypus/schemas";
import { joinUrl } from "@/lib/utils";

const AgentEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; agentId: string }>;
}) => {
  const { orgId, workspaceId, agentId } = await params;

  // Use internal URL for SSR, fallback to BACKEND_URL for local dev
  const backendUrl =
    process.env.INTERNAL_BACKEND_URL || process.env.BACKEND_URL;

  // Fetch tool sets from the server
  const headersList = await headers();
  const [toolSetsResponse] = await Promise.all([
    fetch(
      joinUrl(
        backendUrl || "",
        `/organizations/${orgId}/workspaces/${workspaceId}/tools`,
      ),
      {
        headers: {
          cookie: headersList.get("cookie") || "",
        },
      },
    ),
  ]);

  const toolSetsData = await toolSetsResponse.json();
  const toolSets: ToolSet[] = toolSetsData.results;

  return (
    <div className="flex justify-center pb-8">
      <div className="xl:w-2/5">
        <BackButton
          fallbackHref={`/${orgId}/workspace/${workspaceId}/agents`}
        />
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
