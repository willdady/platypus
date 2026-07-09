import { AgentForm } from "@/components/agent-form";
import { headers } from "next/headers";
import { BackButton } from "@/components/back-button";
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
    <div>
      <BackButton fallbackHref={`/${orgId}/settings/agents`} />
      <h1 className="text-2xl mb-4 font-bold">Edit Shared Agent</h1>
      <AgentForm
        orgId={orgId}
        agentId={agentId}
        toolSets={toolSets}
        orgScoped
      />
    </div>
  );
};

export default OrgAgentEditPage;
