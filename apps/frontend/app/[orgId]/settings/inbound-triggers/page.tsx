import type { Metadata } from "next";
import { OrgInboundTriggerAccess } from "@/components/org-gate-access";
import { OrgInboundTriggersList } from "@/components/org-inbound-triggers-list";

export const metadata: Metadata = { title: "Inbound Triggers" };

async function OrgInboundTriggersPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Inbound Triggers</h1>
      <p className="text-muted-foreground mb-6">
        Triggers that a system outside Platypus can call. Decide here which
        workspaces accept those calls. Workspace owners create the triggers and
        manage their tokens. You can revoke a token to stop its calls straight
        away.
      </p>

      <h2 className="text-lg font-semibold mb-3">Access</h2>
      <div className="mb-8">
        <OrgInboundTriggerAccess orgId={orgId} />
      </div>

      <h2 className="text-lg font-semibold mb-3">Triggers</h2>
      <OrgInboundTriggersList orgId={orgId} />
    </div>
  );
}

export default OrgInboundTriggersPage;
