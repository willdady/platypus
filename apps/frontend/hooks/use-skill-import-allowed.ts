import {
  gateAdmits,
  type Organization,
  type Workspace,
} from "@platypus/schemas";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import {
  organizationEntity,
  workspaceEntity,
  type Scope,
} from "@/lib/api-write";

/**
 * Whether Skill bundles may be imported here: always at Organization scope,
 * which only an Org Admin reaches; in a Workspace, only where the
 * Organization's Skill import gate lets it in (ADR-0037). `false` until both
 * have loaded, so a blocked action never shows and then disappears.
 */
export function useSkillImportAllowed({ orgId, workspaceId }: Scope): boolean {
  const orgScope = orgId && workspaceId ? { orgId } : null;
  const { data: organization } = useScopedSWR<Organization>(
    organizationEntity(orgId ?? ""),
    orgScope && {},
  );
  const { data: workspace } = useScopedSWR<Workspace>(
    workspaceEntity(workspaceId ?? ""),
    orgScope,
  );
  if (!orgScope) return true;
  return (
    organization !== undefined &&
    workspace !== undefined &&
    gateAdmits(organization.skillImportGate, workspace.skillImportAllowed)
  );
}
