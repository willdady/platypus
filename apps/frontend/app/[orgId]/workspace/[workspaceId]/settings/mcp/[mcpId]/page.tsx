import { McpForm } from "@/components/mcp-form";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

const McpEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; mcpId: string }>;
}) => {
  const { orgId, workspaceId, mcpId } = await params;

  return (
    <div>
      <Button className="mb-8" variant="outline" size="sm" asChild>
        <Link href={`/${orgId}/workspace/${workspaceId}/settings/mcp`}>
          <ArrowLeft /> Back
        </Link>
      </Button>
      <h1 className="text-2xl mb-4 font-bold">Edit MCP</h1>
      <McpForm orgId={orgId} workspaceId={workspaceId} mcpId={mcpId} />
    </div>
  );
};

export default McpEditPage;
