import { McpList } from "@/components/mcp-list";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";

const McpPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <McpList orgId={orgId} workspaceId={workspaceId} />
      <Button asChild>
        <Link href={`/${orgId}/workspace/${workspaceId}/settings/mcp/create`}>
          <Plus /> Add MCP
        </Link>
      </Button>
    </div>
  );
};

export default McpPage;
