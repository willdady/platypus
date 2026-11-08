"use client";

import { CopyRow } from "@/components/copy-row";
import { WorkspaceForm } from "@/components/workspace-form";
import { PageHeader } from "@/components/page-header";

function WorkspaceSettingsPage({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  return (
    <div>
      <PageHeader title="Workspace Settings" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-4">
        <CopyRow
          id="organization-id"
          label="Organization ID"
          value={orgId}
          copiedMessage="Organization ID copied"
        />
        <CopyRow
          id="workspace-id"
          label="Workspace ID"
          value={workspaceId}
          copiedMessage="Workspace ID copied"
        />
      </div>

      <div className="w-full">
        <WorkspaceForm orgId={orgId} workspaceId={workspaceId} />
      </div>
    </div>
  );
}

export default WorkspaceSettingsPage;
