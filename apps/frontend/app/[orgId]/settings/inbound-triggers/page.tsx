import type { Metadata } from "next";
import { OrgInboundTriggerAccess } from "@/components/org-gate-access";
import { OrgInboundTriggersList } from "@/components/org-inbound-triggers-list";
import { PageHeader } from "@/components/page-header";
import { SettingsSectionHeading } from "@/components/settings-section-heading";

export const metadata: Metadata = { title: "Inbound Triggers" };

async function OrgInboundTriggersPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <div>
      <PageHeader
        title="Inbound Triggers"
        description="Triggers that a system outside Platypus can call. Decide here which workspaces accept those calls. Workspace owners create the triggers and manage their tokens. You can revoke a token to stop its calls straight away."
      />

      <SettingsSectionHeading>Access</SettingsSectionHeading>
      <div className="mb-8">
        <OrgInboundTriggerAccess orgId={orgId} />
      </div>

      <SettingsSectionHeading>Triggers</SettingsSectionHeading>
      <OrgInboundTriggersList orgId={orgId} />
    </div>
  );
}

export default OrgInboundTriggersPage;
