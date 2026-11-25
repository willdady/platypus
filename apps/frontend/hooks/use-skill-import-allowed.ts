import { gateAdmits } from "@platypus/schemas";
import { useOrganization } from "@/hooks/use-organization";
import { useWorkspace } from "@/hooks/use-workspace";
import { type Scope } from "@/lib/api-write";

export function useSkillImportAllowed({ orgId, workspaceId }: Scope): boolean {
  const enabled = Boolean(orgId && workspaceId);
  const { data: organization } = useOrganization(orgId ?? "", { enabled });
  const { data: workspace } = useWorkspace(orgId ?? "", workspaceId ?? "", {
    enabled,
  });
  if (!enabled) return true;
  return (
    organization !== undefined &&
    workspace !== undefined &&
    gateAdmits(organization.skillImportGate, workspace.skillImportAllowed)
  );
}
