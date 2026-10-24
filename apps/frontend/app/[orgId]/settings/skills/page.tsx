import type { Metadata } from "next";
import { SkillsList } from "@/components/skills-list";
import { OrgSkillImportAccess } from "@/components/org-gate-access";

export const metadata: Metadata = { title: "Organization Skills" };

async function OrgSkillsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Organization Skills</h1>
      <p className="text-muted-foreground mb-6">
        Skills defined here are shared resources. They appear in a workspace
        only where an admin attaches them, and are edited only here.
      </p>
      <SkillsList orgId={orgId} />

      <h2 className="text-lg font-semibold mt-8 mb-3">
        Importing in workspaces
      </h2>
      <OrgSkillImportAccess orgId={orgId} />
    </div>
  );
}

export default OrgSkillsPage;
