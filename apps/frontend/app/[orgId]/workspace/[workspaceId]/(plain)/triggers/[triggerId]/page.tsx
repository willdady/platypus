import type { Metadata } from "next";
import Link from "next/link";
import { List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TriggerForm } from "@/components/trigger-form";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

type Params = Promise<{
  orgId: string;
  workspaceId: string;
  triggerId: string;
}>;

export const metadata: Metadata = { title: "Edit Trigger" };

async function EditTriggerPage({ params }: { params: Params }) {
  const { orgId, workspaceId, triggerId } = await params;
  const routes = workspaceRoutes(orgId, workspaceId);

  return (
    <ResourcePage
      title="Edit Trigger"
      variant="narrow"
      actions={
        <Button variant="outline" asChild>
          <Link href={routes.triggerRuns.forTrigger(triggerId)}>
            <List /> View runs
          </Link>
        </Button>
      }
    >
      <TriggerForm
        orgId={orgId}
        workspaceId={workspaceId}
        triggerId={triggerId}
      />
    </ResourcePage>
  );
}

export default EditTriggerPage;
