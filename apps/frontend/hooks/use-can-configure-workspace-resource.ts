"use client";

import { useAuth } from "@/components/auth-provider";
import {
  canConfigureWorkspaceResource,
  type DelegatableResourceType,
  type WorkspaceDelegationFlags,
} from "@/lib/authorization";

/** The delegation flag each delegatable resource type reads (ADR-0006). */
const DELEGATION_FLAG: Record<
  DelegatableResourceType,
  keyof WorkspaceDelegationFlags
> = {
  provider: "providerSelfManagement",
  mcp: "mcpSelfManagement",
};

/**
 * ADR-0006: may the signed-in actor configure this resource in the Workspace
 * in scope? Resolves the auth module's `canConfigureWorkspaceResource` rule
 * against the Workspace's own delegation flags, so the sidebar, a resource
 * list, its empty state and a form ask the same question in one place.
 */
export function useCanConfigureWorkspaceResource(
  type: DelegatableResourceType,
): boolean {
  const { actor, workspaceDelegation } = useAuth();
  return canConfigureWorkspaceResource(
    actor,
    type,
    workspaceDelegation?.[DELEGATION_FLAG[type]] === true,
  );
}
