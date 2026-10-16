import type { Metadata } from "next";
import { WorkspaceContextForm } from "@/components/workspace-context-form";
import { ResourcePage } from "@/components/resource-page";
import { userRoutes } from "@/lib/routes";

export const metadata: Metadata = { title: "Create Workspace Context" };

const WorkspaceContextCreatePage = () => {
  return (
    <ResourcePage
      backFallbackHref={userRoutes.contexts}
      title="Create Workspace Context"
    >
      <WorkspaceContextForm />
    </ResourcePage>
  );
};

export default WorkspaceContextCreatePage;
