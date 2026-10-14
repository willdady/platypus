"use client";

import { use } from "react";
import Link from "next/link";
import { List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TriggerForm } from "@/components/trigger-form";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

const EditTriggerPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; triggerId: string }>;
}) => {
  const { orgId, workspaceId, triggerId } = use(params);
  const routes = workspaceRoutes(orgId, workspaceId);

  return (
    <ResourcePage
      backFallbackHref={routes.root}
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
};

export default EditTriggerPage;
