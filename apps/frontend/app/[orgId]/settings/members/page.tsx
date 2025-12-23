"use client";

import { useParams } from "next/navigation";

const OrgMembersPage = () => {
  const { orgId } = useParams<{
    orgId: string;
  }>();

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Members</h1>
      <p className="text-muted-foreground">
        Manage members of the organisation <strong>{orgId}</strong>.
      </p>
      <div className="mt-8 p-8 border border-dashed rounded-lg text-center">
        <p className="text-muted-foreground">Member management coming soon.</p>
      </div>
    </div>
  );
};

export default OrgMembersPage;
