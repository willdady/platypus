import type { Metadata } from "next";
import { WorkspaceContextForm } from "@/components/workspace-context-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Add Workspace Context" };

function WorkspaceContextCreatePage() {
  return (
    <ResourcePage title="Add Workspace Context">
      <WorkspaceContextForm />
    </ResourcePage>
  );
}

export default WorkspaceContextCreatePage;
