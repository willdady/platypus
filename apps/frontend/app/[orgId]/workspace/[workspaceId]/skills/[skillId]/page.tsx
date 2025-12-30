import { SkillForm } from "@/components/skill-form";
import { BackButton } from "@/components/back-button";

const SkillEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; skillId: string }>;
}) => {
  const { orgId, workspaceId, skillId } = await params;

  return (
    <div className="flex justify-center pb-8">
      <div className="xl:w-2/5">
        <BackButton fallbackHref={`/${orgId}/workspace/${workspaceId}`} />
        <h1 className="text-2xl mb-4 font-bold">Edit Skill</h1>
        <SkillForm orgId={orgId} workspaceId={workspaceId} skillId={skillId} />
      </div>
    </div>
  );
};

export default SkillEditPage;
