import { gateAdmits } from "@platypus/schemas";
import { useOrganization } from "@/hooks/use-organization";
import { useWorkspace } from "@/hooks/use-workspace";
import { type Scope } from "@/lib/api-write";

/**
 * Whether Skill bundles may be imported here: always at Organization scope,
 * which only an Org Admin reaches; in a Workspace, only where the
 * Organization's Skill import gate lets it in (ADR-0037). `false` until both
 * have loaded, so a blocked action never shows and then disappears.
 */
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
