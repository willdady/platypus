import { McpForm } from "@/components/mcp-form";
import { BackButton } from "@/components/back-button";

const CreateOrgMcpPage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <div>
      <BackButton fallbackHref={`/${orgId}/settings/mcp`} />
      <h1 className="text-2xl font-bold mb-4">Add Organization MCP</h1>
      <McpForm orgId={orgId} />
    </div>
  );
};

export default CreateOrgMcpPage;
