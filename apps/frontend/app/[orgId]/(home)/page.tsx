import type { Metadata } from "next";
import type { Organization } from "@platypus/schemas";
import { OrgHome } from "@/components/org-home";
import { backendPath, readForLabel } from "@/lib/server-read";

type Params = Promise<{ orgId: string }>;

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { orgId } = await params;
  const organization = await readForLabel<Organization>(
    backendPath`/organizations/${orgId}`,
  );
  return { title: organization?.name || "Organization" };
}

export default async function OrgPage({ params }: { params: Params }) {
  const { orgId } = await params;
  return <OrgHome orgId={orgId} />;
}
