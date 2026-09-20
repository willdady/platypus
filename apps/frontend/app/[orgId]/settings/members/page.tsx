"use client";

import { useParams } from "next/navigation";
import { type OrgMemberListItem, type Organization } from "@platypus/schemas";
import { MembersList } from "@/components/members-list";
import { Users } from "lucide-react";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { organizationEntity } from "@/lib/api-write";

const OrgMembersPage = () => {
  const { orgId } = useParams<{ orgId: string }>();
  const { data: orgData } = useScopedSWR<Organization>(
    organizationEntity(orgId),
    {},
  );
  const { data, mutate, isLoading } = useScopedSWR<{
    results: OrgMemberListItem[];
  }>("members", { orgId });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold mb-4">Members</h1>
        <p className="text-muted-foreground">
          Manage members of{" "}
          <span className="font-bold">
            {orgData?.name || "this organization"}
          </span>{" "}
          and their workspace access.
        </p>
      </div>

      {isLoading ? (
        <p>Loading members...</p>
      ) : data?.results.length === 0 ? (
        <div className="text-center py-12 border border-dashed rounded-lg">
          <Users className="mx-auto h-12 w-12 text-muted-foreground/50 mb-4" />
          <p className="text-muted-foreground">No members found.</p>
        </div>
      ) : (
        <MembersList
          orgId={orgId}
          members={data?.results || []}
          onUpdate={() => mutate()}
        />
      )}
    </div>
  );
};

export default OrgMembersPage;
