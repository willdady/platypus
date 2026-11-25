import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { organizationEntity } from "@/lib/api-write";
import type { Organization } from "@platypus/schemas";

export function useOrganization(
  orgId: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  // why: {} reads the root collection; { orgId } would nest the Organization under it
  return useScopedSWR<Organization>(
    organizationEntity(orgId),
    enabled ? {} : null,
  );
}
