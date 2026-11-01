import type { Metadata } from "next";
import { SkillForm } from "@/components/skill-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Edit Skill" };

async function SkillEditPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; skillId: string }>;
}) {
  const { orgId, workspaceId, skillId } = await params;

  return (
    <ResourcePage title="Edit Skill" variant="narrow">
      <SkillForm orgId={orgId} workspaceId={workspaceId} skillId={skillId} />
    </ResourcePage>
  );
}

export default SkillEditPage;
