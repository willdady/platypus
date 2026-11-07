"use client";
import { useOrganization } from "@/hooks/use-organization";
import { OrganizationName } from "@/components/organization-name";

import { useParams } from "next/navigation";
import type { OrgMemberListItem } from "@platypus/schemas";
import { MembersList } from "@/components/members-list";
import { ListError } from "@/components/list-state";
import { Users } from "lucide-react";
import { EmptyCard } from "@/components/empty-card";
import { useScopedList } from "@/hooks/use-scoped-list";
import {
  BadgeSkeleton,
  IconButtonSkeleton,
  LoadingRegion,
  TableSkeleton,
  UserCellSkeleton,
} from "@/components/list-skeletons";

function OrgMembersPage() {
  const { orgId } = useParams<{ orgId: string }>();
  useOrganization(orgId);
  const {
    data,
    results: members,
    error,
    mutate,
    isLoading,
  } = useScopedList<OrgMemberListItem>("members", { orgId });

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold mb-4">Members</h1>
        <p className="text-muted-foreground">
          Manage members of <OrganizationName orgId={orgId} /> and their
          workspace access.
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
      ) : error && !data ? (
        <ListError error={error} subject="members" onRetry={() => mutate()} />
      ) : data && members.length === 0 ? (
        <EmptyCard
          icon={<Users />}
          title="No members yet"
          description="People join this organization by accepting an invitation. Send one from Invitations."
        />
      ) : (
        <MembersList
          orgId={orgId}
          members={members}
          onUpdate={() => mutate()}
        />
      )}
    </div>
  );
}

export default OrgMembersPage;
