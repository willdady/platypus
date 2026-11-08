import type { Metadata } from "next";
import { SkillsList } from "@/components/skills-list";
import { OrgSkillImportAccess } from "@/components/org-gate-access";
import { PageHeader } from "@/components/page-header";
import { SettingsSectionHeading } from "@/components/settings-section-heading";

export const metadata: Metadata = { title: "Organization Skills" };

async function OrgSkillsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <div>
      <PageHeader
        title="Organization Skills"
        description="Skills defined here are shared resources. They appear in a workspace only where an admin attaches them, and are edited only here."
      />
      <SkillsList orgId={orgId} />

      <SettingsSectionHeading className="mt-8">
        Importing in workspaces
      </SettingsSectionHeading>
      <OrgSkillImportAccess orgId={orgId} />
    </div>
  );
}

export default OrgSkillsPage;
