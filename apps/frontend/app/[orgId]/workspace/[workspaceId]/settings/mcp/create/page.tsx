import { McpForm } from "@/components/mcp-form";
import { BackButton } from "@/components/back-button";

const McpCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <BackButton
        fallbackHref={`/${orgId}/workspace/${workspaceId}/settings/mcp`}
      />
      <h1 className="text-2xl mb-4 font-bold">Create MCP</h1>
      <McpForm orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
};

export default McpCreatePage;
