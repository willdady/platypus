import { ResourcePage } from "@/components/resource-page";
import { AgentFormSkeleton } from "@/components/agent-form-skeleton";
import { LoadingRegion } from "@/components/list-skeletons";

// The page awaits the org tool sets on the server before it renders anything,
// so without this a navigation here sat on the previous page with no feedback.
export default function OrgAgentEditLoading() {
  return (
    <ResourcePage title="Edit Shared Agent">
      <LoadingRegion label="Loading agent">
        <AgentFormSkeleton editing />
      </LoadingRegion>
    </ResourcePage>
  );
}
