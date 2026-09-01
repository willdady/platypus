import { SkillForm } from "@/components/skill-form";
import { ResourcePage } from "@/components/resource-page";

const CreateOrgSkillPage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/settings/skills`}
      title="Create Organization Skill"
    >
      <SkillForm orgId={orgId} />
    </ResourcePage>
  );
};

export default CreateOrgSkillPage;
