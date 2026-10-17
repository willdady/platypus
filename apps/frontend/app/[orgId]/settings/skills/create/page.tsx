import type { Metadata } from "next";
import { SkillForm } from "@/components/skill-form";
import { ResourcePage } from "@/components/resource-page";
import { orgRoutes } from "@/lib/routes";

export const metadata: Metadata = { title: "Create Organization Skill" };

async function CreateOrgSkillPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <ResourcePage
      backFallbackHref={orgRoutes(orgId).settings.skills}
      title="Create Organization Skill"
    >
      <SkillForm orgId={orgId} />
    </ResourcePage>
  );
}

export default CreateOrgSkillPage;
