import type { Metadata } from "next";
import { SkillForm } from "@/components/skill-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Create Skill" };

async function SkillCreatePage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage title="Create Skill" variant="narrow">
      <SkillForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
}

export default SkillCreatePage;
