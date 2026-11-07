import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { organizationEntity, workspaceEntity } from "@/lib/api-write";
import type { Organization, Workspace } from "@platypus/schemas";

/**
 * Options both row reads accept. `enabled: false` withholds the fetch the
 * same way a `null` scope does — for a read that depends on something that
 * has not resolved yet (e.g. `useSkillImportAllowed`).
 */
export type RowReadOptions = {
  readonly enabled?: boolean;
};

/**
 * One Organization row, keyed through `organizationEntity` and read from the
 * root `/organizations` collection — the scope is `{}`, NOT `{ orgId }`,
 * which would nest the Organization under itself (see `organizationEntity`)
 * and put the read on a cache key nothing else shares.
 */
export function useOrganization(
  orgId: string,
  { enabled = true }: RowReadOptions = {},
) {
  return useScopedSWR<Organization>(
    organizationEntity(orgId),
    enabled ? {} : null,
  );
}

/**
 * One Workspace row, keyed through `workspaceEntity` and read under its
 * Organization's scope.
 */
export function useWorkspace(
  orgId: string,
  workspaceId: string,
  { enabled = true }: RowReadOptions = {},
) {
  return useScopedSWR<Workspace>(
    workspaceEntity(workspaceId),
    enabled ? { orgId } : null,
  );
}
