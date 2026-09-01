import { SkillForm } from "@/components/skill-form";
import { ResourcePage } from "@/components/resource-page";

const SkillCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/workspace/${workspaceId}`}
      title="Create Skill"
      variant="create"
    >
      <SkillForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
};

export default SkillCreatePage;
