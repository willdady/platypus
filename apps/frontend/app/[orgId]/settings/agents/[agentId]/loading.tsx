"use client";

import { useParams } from "next/navigation";
import { ResourcePage } from "@/components/resource-page";
import { AgentFormSkeleton } from "@/components/agent-form-skeleton";
import { orgRoutes } from "@/lib/routes";

// The page awaits the org tool sets on the server before it renders anything,
// so without this a navigation here sat on the previous page with no
// feedback. A `loading` file gets no `params`, hence the client read.
export default function OrgAgentEditLoading() {
  const { orgId } = useParams<{ orgId: string }>();

  return (
    <ResourcePage
      backFallbackHref={orgRoutes(orgId).settings.agents}
      title="Edit Shared Agent"
    >
      <div role="status" aria-busy="true" aria-label="Loading agent">
        <AgentFormSkeleton editing />
      </div>
    </ResourcePage>
  );
}
