"use client";

import { useAuth } from "@/components/auth-provider";
import {
  canConfigureWorkspaceResource,
  type DelegatableResourceType,
  type WorkspaceDelegationFlags,
} from "@/lib/authorization";

const DELEGATION_FLAG: Record<
  DelegatableResourceType,
  keyof WorkspaceDelegationFlags
> = {
  provider: "providerSelfManagement",
  mcp: "mcpSelfManagement",
};

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
