"use client";

import { CopyRow } from "@/components/copy-row";
import { OrganizationForm } from "@/components/organization-form";
import { PageHeader } from "@/components/page-header";

function OrgSettingsPage({ orgId }: { orgId: string }) {
  return (
    <div>
      <PageHeader title="Organization Settings" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-4">
        <CopyRow
          id="organization-id"
          label="Organization ID"
          value={orgId}
          copiedMessage="Organization ID copied"
        />
      </div>

      <div className="max-w-md">
        <OrganizationForm orgId={orgId} />
      </div>
    </div>
  );
}

export default OrgSettingsPage;
