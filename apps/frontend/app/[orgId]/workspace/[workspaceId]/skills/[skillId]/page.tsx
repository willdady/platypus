import { SkillForm } from "@/components/skill-form";
import { ResourcePage } from "@/components/resource-page";

const SkillEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; skillId: string }>;
}) => {
  const { orgId, workspaceId, skillId } = await params;

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/workspace/${workspaceId}`}
      title="Edit Skill"
      variant="create"
    >
      <SkillForm orgId={orgId} workspaceId={workspaceId} skillId={skillId} />
    </ResourcePage>
  );
};

export default SkillEditPage;
