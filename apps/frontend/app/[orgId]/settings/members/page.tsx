"use client";

import { useParams } from "next/navigation";
import { useBackendUrl } from "@/app/client-context";
import { fetcher, joinUrl } from "@/lib/utils";
import { type OrgMemberListItem, type Organization } from "@platypus/schemas";
import { MembersList } from "@/components/members-list";
import { Users } from "lucide-react";
import useSWR from "swr";
import { useAuth } from "@/components/auth-provider";

const OrgMembersPage = () => {
  const { user } = useAuth();
  const { orgId } = useParams<{ orgId: string }>();
  const backendUrl = useBackendUrl();
  const { data: orgData } = useSWR<Organization>(
    backendUrl && user ? joinUrl(backendUrl, `/organizations/${orgId}`) : null,
    fetcher,
  );
  const { data, mutate, isLoading } = useSWR<{ results: OrgMemberListItem[] }>(
    backendUrl && user
      ? joinUrl(backendUrl, `/organizations/${orgId}/members`)
      : null,
    fetcher,
  );

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
