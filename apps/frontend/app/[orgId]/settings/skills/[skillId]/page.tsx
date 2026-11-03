import type { Metadata } from "next";
import { SkillForm } from "@/components/skill-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Edit Organization Skill" };

async function EditOrgSkillPage({
  params,
}: {
  params: Promise<{ orgId: string; skillId: string }>;
}) {
  const { orgId, skillId } = await params;

  return (
    <ResourcePage title="Edit Organization Skill">
      <SkillForm orgId={orgId} skillId={skillId} />
    </ResourcePage>
  );
}

export default EditOrgSkillPage;
