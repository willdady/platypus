import type { Metadata } from "next";
import { SkillGithubInstall } from "@/components/skill-github-install";
import { ResourcePage } from "@/components/resource-page";
import { orgRoutes } from "@/lib/routes";

export const metadata: Metadata = {
  title: "Install Organization Skills from GitHub",
};

async function OrgSkillInstallPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const { settings } = orgRoutes(orgId);

  return (
    <ResourcePage
      backFallbackHref={settings.skills}
      title="Install Organization Skills from GitHub"
    >
      <SkillGithubInstall
        scope={{ orgId }}
        skillsHref={settings.skills}
        skillHrefBase={settings.skills}
      />
    </ResourcePage>
  );
}

export default OrgSkillInstallPage;
