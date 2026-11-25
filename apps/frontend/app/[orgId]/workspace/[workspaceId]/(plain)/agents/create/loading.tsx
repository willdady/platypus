import { ResourcePage } from "@/components/resource-page";
import { AgentFormSkeleton } from "@/components/agent-form-skeleton";
import { LoadingRegion } from "@/components/list-skeletons";

// why: the page awaits tool sets on the server, so a navigation here would stall
export default function AgentCreateLoading() {
  return (
    <ResourcePage title="Create Agent" variant="narrow">
      <LoadingRegion label="Loading form">
        <AgentFormSkeleton />
      </LoadingRegion>
    </ResourcePage>
  );
}
