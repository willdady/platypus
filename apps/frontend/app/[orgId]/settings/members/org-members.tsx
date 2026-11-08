"use client";

import { useParams } from "next/navigation";
import type { OrgMemberListItem } from "@platypus/schemas";
import { MembersList } from "@/components/members-list";
import { Users } from "lucide-react";
import { EmptyCard } from "@/components/empty-card";
import { useScopedList } from "@/hooks/use-scoped-list";
import {
  BadgeSkeleton,
  IconButtonSkeleton,
  TableSkeleton,
  UserCellSkeleton,
} from "@/components/list-skeletons";
import { TableList } from "@/components/table-list";
import { OrganizationName } from "@/components/organization-name";
import { PageHeader } from "@/components/page-header";

function OrgMembersPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const {
    data,
    results: members,
    error,
    mutate,
    isLoading,
  } = useScopedList<OrgMemberListItem>("members", { orgId });

  return (
    <div>
      <PageHeader
        title="Members"
        description={
          <>
            Manage members of <OrganizationName orgId={orgId} /> and their
            workspace access.
          </>
        }
      />

      <TableList
        isLoading={isLoading}
        data={data}
        error={error}
        subject="members"
        skeleton={
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
        }
        empty={
          <EmptyCard
            icon={<Users />}
            title="No members yet"
            description="People join this organization by accepting an invitation. Send one from Invitations."
          />
        }
        isEmpty={members.length === 0}
        onRetry={() => mutate()}
      >
        <MembersList
          orgId={orgId}
          members={members}
          onUpdate={() => mutate()}
        />
      </TableList>
    </div>
  );
}

export default OrgMembersPage;
