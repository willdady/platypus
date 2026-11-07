"use client";

import { useOrganization } from "@/hooks/use-organization";
import { InlineSkeleton } from "@/components/list-skeletons";

/**
 * The Organization's name in running text: a skeleton while the row loads,
 * then the bolded name, else "this organization". The Members and Invitations
 * settings pages used to repeat this block by hand.
 */
export function OrganizationName({ orgId }: { orgId: string }) {
  const { data: organization, isLoading } = useOrganization(orgId);
  if (isLoading) return <InlineSkeleton className="w-32" />;
  return (
    <span className="font-bold">
      {organization?.name || "this organization"}
    </span>
  );
}
