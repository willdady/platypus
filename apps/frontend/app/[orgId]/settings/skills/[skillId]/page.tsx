import { SkillForm } from "@/components/skill-form";
import { BackButton } from "@/components/back-button";

const EditOrgSkillPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; skillId: string }>;
}) => {
  const { orgId, skillId } = await params;

  return (
    <div>
      <BackButton fallbackHref={`/${orgId}/settings/skills`} />
      <h1 className="text-2xl font-bold mb-4">Edit Organization Skill</h1>
      <SkillForm orgId={orgId} skillId={skillId} />
    </div>
  );
};

export default EditOrgSkillPage;
