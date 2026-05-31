import { SkillsList } from "@/components/skills-list";

const OrgSkillsPage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Organization Skills</h1>
      <p className="text-muted-foreground mb-6">
        Skills defined here are shared resources. They appear in a workspace
        only where an admin attaches them, and are edited only here.
      </p>
      <SkillsList orgId={orgId} />
    </div>
  );
};

export default OrgSkillsPage;
