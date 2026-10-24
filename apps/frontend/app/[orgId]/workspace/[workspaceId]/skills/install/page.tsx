import type { Metadata } from "next";
import { SkillGithubInstall } from "@/components/skill-github-install";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

export const metadata: Metadata = { title: "Install Skills from GitHub" };

async function SkillInstallPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;
  const routes = workspaceRoutes(orgId, workspaceId);

  return (
    <ResourcePage
      backFallbackHref={routes.root}
      title="Install Skills from GitHub"
      variant="narrow"
    >
      <SkillGithubInstall
        scope={{ orgId, workspaceId }}
        skillsHref={routes.root}
        skillHrefBase={routes.skills.root}
      />
    </ResourcePage>
  );
}

export default SkillInstallPage;
