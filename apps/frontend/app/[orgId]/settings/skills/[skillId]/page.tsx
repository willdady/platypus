import { SkillForm } from "@/components/skill-form";
import { ResourcePage } from "@/components/resource-page";
import { orgRoutes } from "@/lib/routes";

const EditOrgSkillPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; skillId: string }>;
}) => {
  const { orgId, skillId } = await params;

  return (
    <ResourcePage
      backFallbackHref={orgRoutes(orgId).settings.skills}
      title="Edit Organization Skill"
    >
      <SkillForm orgId={orgId} skillId={skillId} />
    </ResourcePage>
  );
};

export default EditOrgSkillPage;
