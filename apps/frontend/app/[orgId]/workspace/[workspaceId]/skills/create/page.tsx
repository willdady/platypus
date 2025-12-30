import { SkillForm } from "@/components/skill-form";
import { BackButton } from "@/components/back-button";

const SkillCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <div className="flex justify-center pb-8">
      <div className="xl:w-2/5">
        <BackButton fallbackHref={`/${orgId}/workspace/${workspaceId}`} />
        <h1 className="text-2xl mb-4 font-bold">Create Skill</h1>
        <SkillForm orgId={orgId} workspaceId={workspaceId} />
      </div>
    </div>
  );
};

export default SkillCreatePage;
