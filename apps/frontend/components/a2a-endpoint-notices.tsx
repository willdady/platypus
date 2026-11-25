"use client";

import { Ban } from "lucide-react";
import { gateAdmits } from "@platypus/schemas";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useOrganization } from "@/hooks/use-organization";
import { useWorkspace } from "@/hooks/use-workspace";

export function A2aEndpointNotices({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const { data: organization } = useOrganization(orgId);
  const { data: workspace } = useWorkspace(orgId, workspaceId);
  const gateClosed =
    organization !== undefined &&
    (organization.a2aGate !== "selected" || workspace !== undefined) &&
    !gateAdmits(organization.a2aGate, workspace?.a2aAllowed);

  if (!gateClosed) return null;

  return (
    <Alert className="mb-6">
      <Ban />
      <AlertTitle>A2A endpoints are turned off here</AlertTitle>
      <AlertDescription>
        Your organization doesn&apos;t allow A2A endpoints in this workspace, so
        they answer every call with Not Found. Ask an organization admin to
        allow them.
      </AlertDescription>
    </Alert>
  );
}
