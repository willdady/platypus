import type { Metadata } from "next";
import { OrgA2aAccess } from "@/components/org-gate-access";
import { OrgA2aEndpointsList } from "@/components/org-a2a-endpoints-list";
import { PageHeader } from "@/components/page-header";
import { SettingsSectionHeading } from "@/components/settings-section-heading";

export const metadata: Metadata = { title: "A2A endpoints" };

async function OrgA2aPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;

  return (
    <div>
      <PageHeader
        title="A2A endpoints"
        description="A2A endpoints let agents and chat apps outside Platypus talk to an agent in a workspace. Decide here which workspaces can have them. Workspace owners create the endpoints and their tokens. You can revoke an endpoint or a token to stop its calls straight away."
      />

      <SettingsSectionHeading>Access</SettingsSectionHeading>
      <div className="mb-8">
        <OrgA2aAccess orgId={orgId} />
      </div>

      <SettingsSectionHeading>Endpoints</SettingsSectionHeading>
      <OrgA2aEndpointsList orgId={orgId} />
    </div>
  );
}

export default OrgA2aPage;
