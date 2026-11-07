import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { workspaceEntity } from "@/lib/api-write";
import type { Workspace } from "@platypus/schemas";

/**
 * One Workspace row, keyed through `workspaceEntity` and read under its
 * Organization's scope. `enabled: false` withholds the fetch, as in
 * `useOrganization`.
 */
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
