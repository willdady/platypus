import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { workspaceEntity } from "@/lib/api-write";
import type { Workspace } from "@platypus/schemas";

export function useWorkspace(
  orgId: string,
  workspaceId: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useScopedSWR<Workspace>(
    workspaceEntity(workspaceId),
    enabled ? { orgId } : null,
  );
}
