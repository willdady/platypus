"use client";

import { ResourcePage } from "@/components/resource-page";
import { AgentFormSkeleton } from "@/components/agent-form-skeleton";

// The page awaits the org tool sets on the server before it renders anything,
// so without this a navigation here sat on the previous page with no feedback.
export default function OrgAgentEditLoading() {
  return (
    <ResourcePage title="Edit Shared Agent">
      <div role="status" aria-busy="true" aria-label="Loading agent">
        <AgentFormSkeleton editing />
      </div>
    </ResourcePage>
  );
}
