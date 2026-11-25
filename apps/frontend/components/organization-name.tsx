"use client";

import { useOrganization } from "@/hooks/use-organization";
import { InlineSkeleton } from "@/components/list-skeletons";

export function OrganizationName({ orgId }: { orgId: string }) {
  const { data: organization, isLoading } = useOrganization(orgId);
  if (isLoading) return <InlineSkeleton className="w-32" />;
  return (
    <span className="font-bold">
      {organization?.name || "this organization"}
    </span>
  );
}
