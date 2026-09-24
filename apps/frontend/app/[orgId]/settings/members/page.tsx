"use client";

import { useParams } from "next/navigation";
import { type OrgMemberListItem, type Organization } from "@platypus/schemas";
import { MembersList } from "@/components/members-list";
import { Users } from "lucide-react";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { organizationEntity } from "@/lib/api-write";
import {
  BadgeSkeleton,
  IconButtonSkeleton,
  InlineSkeleton,
  LoadingRegion,
  TableSkeleton,
  UserCellSkeleton,
} from "@/components/list-skeletons";

const OrgMembersPage = () => {
  const { orgId } = useParams<{ orgId: string }>();
  const { data: orgData, isLoading: isLoadingOrg } = useScopedSWR<Organization>(
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
          {isLoadingOrg ? (
            <InlineSkeleton className="w-32" />
          ) : (
            <span className="font-bold">
              {orgData?.name || "this organization"}
            </span>
          )}{" "}
          and their workspace access.
        </p>
      </div>

      {isLoading ? (
        <LoadingRegion label="Loading members">
          <TableSkeleton
            tableClassName="min-w-[600px]"
            columns={[
              { header: "User", cell: <UserCellSkeleton /> },
              { header: "Org Role", cell: <BadgeSkeleton className="w-14" /> },
              {
                header: "Actions",
                className: "text-right",
                cell: (
                  <div className="flex justify-end">
                    <IconButtonSkeleton />
                  </div>
                ),
              },
            ]}
          />
        </LoadingRegion>
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
