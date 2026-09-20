import { SkillForm } from "@/components/skill-form";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

const SkillEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; skillId: string }>;
}) => {
  const { orgId, workspaceId, skillId } = await params;

  return (
    <ResourcePage
      backFallbackHref={workspaceRoutes(orgId, workspaceId).root}
      title="Edit Skill"
      variant="narrow"
    >
      <SkillForm orgId={orgId} workspaceId={workspaceId} skillId={skillId} />
    </ResourcePage>
  );
};

export default SkillEditPage;
