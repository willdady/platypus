import { SkillForm } from "@/components/skill-form";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

const SkillCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage
      backFallbackHref={workspaceRoutes(orgId, workspaceId).root}
      title="Create Skill"
      variant="narrow"
    >
      <SkillForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
};

export default SkillCreatePage;
