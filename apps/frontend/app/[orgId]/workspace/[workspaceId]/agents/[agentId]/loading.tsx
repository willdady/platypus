"use client";

import { useParams } from "next/navigation";
import { ResourcePage } from "@/components/resource-page";
import { AgentFormSkeleton } from "@/components/agent-form-skeleton";
import { workspaceRoutes } from "@/lib/routes";

// The page awaits the tool sets on the server before it renders anything, so
// without this a navigation here sat on the previous page with no feedback.
// A `loading` file gets no `params`, hence the client read.
export default function AgentEditLoading() {
  const { orgId, workspaceId } = useParams<{
    orgId: string;
    workspaceId: string;
  }>();

  return (
    <ResourcePage
      backFallbackHref={workspaceRoutes(orgId, workspaceId).root}
      title="Edit Agent"
      variant="narrow"
    >
      <div role="status" aria-busy="true" aria-label="Loading agent">
        <AgentFormSkeleton editing />
      </div>
    </ResourcePage>
  );
}
