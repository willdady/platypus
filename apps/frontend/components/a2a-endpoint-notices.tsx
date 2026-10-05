"use client";

import { Ban } from "lucide-react";
import {
  gateAdmits,
  type Organization,
  type Workspace,
} from "@platypus/schemas";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { organizationEntity, workspaceEntity } from "@/lib/api-write";

/**
 * Tells the Owner when the Organization's gate excludes this Workspace, so
 * its A2A endpoints don't answer at all.
 */
export const A2aEndpointNotices = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const { data: organization } = useScopedSWR<Organization>(
    organizationEntity(orgId),
    {},
  );
  const { data: workspace } = useScopedSWR<Workspace>(
    workspaceEntity(workspaceId),
    { orgId },
  );
  // Only once everything the answer depends on has loaded: a Workspace still
  // loading is unknown, not excluded.
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
};
