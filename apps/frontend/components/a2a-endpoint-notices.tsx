"use client";

import { Ban, TriangleAlert } from "lucide-react";
import {
  gateAdmits,
  type Organization,
  type Workspace,
} from "@platypus/schemas";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { organizationEntity, workspaceEntity } from "@/lib/api-write";

/**
 * What an Owner must know before handing out an A2A endpoint: its runs act
 * as them with every one of the Agent's tools, and, when the Organization's
 * gate excludes this Workspace, that its endpoints don't answer at all.
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

  return (
    <div className="mb-6 flex flex-col gap-4">
      <Alert>
        <TriangleAlert />
        <AlertTitle>
          Runs act as you, with all of the agent&apos;s tools
        </AlertTitle>
        <AlertDescription>
          Anyone holding a token can talk to the agent, and every run acts as
          you with every tool the agent has. Only expose an agent whose tools
          are safe for the people you give tokens to.
        </AlertDescription>
      </Alert>
      {gateClosed && (
        <Alert>
          <Ban />
          <AlertTitle>A2A endpoints are turned off here</AlertTitle>
          <AlertDescription>
            Your organization doesn&apos;t allow A2A endpoints in this
            workspace, so they answer every call with Not Found. Ask an
            organization admin to allow them.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
};
