import { SkillForm } from "@/components/skill-form";
import { BackButton } from "@/components/back-button";

const CreateOrgSkillPage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <div>
      <BackButton fallbackHref={`/${orgId}/settings/skills`} />
      <h1 className="text-2xl font-bold mb-4">Create Organization Skill</h1>
      <SkillForm orgId={orgId} />
    </div>
  );
};

export default CreateOrgSkillPage;
