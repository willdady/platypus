import { SkillForm } from "@/components/skill-form";
import { ResourcePage } from "@/components/resource-page";

const EditOrgSkillPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; skillId: string }>;
}) => {
  const { orgId, skillId } = await params;

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/settings/skills`}
      title="Edit Organization Skill"
    >
      <SkillForm orgId={orgId} skillId={skillId} />
    </ResourcePage>
  );
};

export default EditOrgSkillPage;
