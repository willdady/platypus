import { ResourcePage } from "@/components/resource-page";
import { AgentFormSkeleton } from "@/components/agent-form-skeleton";
import { LoadingRegion } from "@/components/list-skeletons";

// The page awaits the tool sets on the server before it renders anything, so
// without this a navigation here sat on the previous page with no feedback.
export default function AgentCreateLoading() {
  return (
    <ResourcePage title="Create Agent" variant="narrow">
      <LoadingRegion label="Loading form">
        <AgentFormSkeleton />
      </LoadingRegion>
    </ResourcePage>
  );
}
