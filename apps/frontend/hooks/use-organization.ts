import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { organizationEntity } from "@/lib/api-write";
import type { Organization } from "@platypus/schemas";

/**
 * One Organization row, keyed through `organizationEntity` and read from the
 * root `/organizations` collection — the scope is `{}`, NOT `{ orgId }`,
 * which would nest the Organization under itself (see `organizationEntity`)
 * and put the read on a cache key nothing else shares.
 *
 * The hook owns the scope, so a caller can't pass `useScopedSWR`'s `null`
 * scope to withhold the fetch; `enabled: false` stands in for it (e.g.
 * `useSkillImportAllowed` before its ids resolve).
 */
export function useOrganization(
  orgId: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useScopedSWR<Organization>(
    organizationEntity(orgId),
    enabled ? {} : null,
  );
}
