import { AgentForm } from "@/components/agent-form";
import { headers } from "next/headers";
import { ResourcePage } from "@/components/resource-page";
import { type ToolSet } from "@platypus/schemas";
import { joinUrl } from "@/lib/utils";

const OrgAgentEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; agentId: string }>;
}) => {
  const { orgId, agentId } = await params;

  // Use internal URL for SSR, fallback to BACKEND_URL for local dev
  const backendUrl =
    process.env.INTERNAL_BACKEND_URL || process.env.BACKEND_URL;

  // Org-scoped tool sets: static sets + org MCPs (the only ones a Shared agent
  // may reference under the no-cascade rule).
  const headersList = await headers();
  const toolSetsResponse = await fetch(
    joinUrl(backendUrl || "", `/organizations/${orgId}/tools`),
    {
      headers: {
        cookie: headersList.get("cookie") || "",
      },
    },
  );

  const toolSetsData = await toolSetsResponse.json();
  const toolSets: ToolSet[] = toolSetsData.results;

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/settings/agents`}
      title="Edit Shared Agent"
    >
      <AgentForm
        orgId={orgId}
        agentId={agentId}
        toolSets={toolSets}
        orgScoped
      />
    </ResourcePage>
  );
};

export default OrgAgentEditPage;
