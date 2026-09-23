"use client";

import { type ComponentType } from "react";
import { Building, Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useAuth } from "@/components/auth-provider";
import {
  canConfigureWorkspaceResource,
  canManageSharedResource,
  type DelegatableResourceType,
  type WorkspaceDelegationFlags,
} from "@/lib/authorization";
import { type Scope } from "@/lib/api-write";
import { orgRoutes, workspaceRoutes } from "@/lib/routes";
import { useSharedDetach } from "@/hooks/use-shared-resource-actions";
import { ListError, ListState } from "./list-state";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import { Button } from "./ui/button";
import {
  AttachSharedAction,
  DetachSharedDialog,
} from "./shared-resource-actions";

/** A list row as the API returns it: an id, a name, and — inside a workspace — its scope. */
interface ScopedResource {
  readonly id: string;
  readonly name: string;
  readonly scope?: "organization" | "workspace";
}

interface EmptyStateProps {
  readonly orgId: string;
  readonly workspaceId: string;
  readonly canManage: boolean;
}

export interface ResourceListLabels {
  /** Create CTA: "Add provider" / "Add MCP". */
  readonly add: string;
  /** Attach CTA: "Attach shared provider" / "Attach shared MCP". */
  readonly attach: string;
  /** Detach dialog title: "Organization Provider" / "Organization MCP". */
  readonly detachTitle: string;
  /** The resource named mid-sentence: "provider" / "MCP server". */
  readonly noun: string;
  /** The resource named in a fetch failure: "providers" / "MCP servers". */
  readonly plural: string;
}

export interface ResourceListConfig {
  /** Collection entity as the API spells it: "providers" / "mcps". */
  readonly entity: string;
  /** Which Shared resource this is — names the attach/detach endpoints (ADR-0007). */
  readonly resourceType: DelegatableResourceType;
  /** Which settings route the resource's own pages live under (`lib/routes`). */
  readonly settingsKey: "providers" | "mcp";
  /** The Workspace delegation flag granting self-management (ADR-0006). */
  readonly delegationFlag: keyof WorkspaceDelegationFlags;
  readonly labels: ResourceListLabels;
  /** Rendered when a workspace has no resources and the caller can neither attach nor create one. */
  readonly emptyState: ComponentType<EmptyStateProps>;
}

/**
 * The Organization-or-Workspace list of a Scoped resource (ADR-0007), one
 * component for providers and MCP servers. The resource nouns, labels, route,
 * delegation flag, and empty state are the parameters; everything else — the
 * read, the org-scoped lock, attach, detach, and the fetch-error state — is
 * shared, so the two resources cannot drift apart again.
 */
export const ResourceList = ({
  orgId,
  workspaceId,
  config,
}: {
  orgId: string;
  workspaceId?: string;
  config: ResourceListConfig;
}) => {
  const { actor, workspaceDelegation } = useAuth();

  // Resolved once per render and reused for the list's read and every write
  // below, rather than re-deriving the Organization-vs-Workspace branch at
  // each call site.
  const scope: Scope = workspaceId ? { orgId, workspaceId } : { orgId };

  const { data, error, isLoading, mutate } = useScopedSWR<{
    results: ScopedResource[];
  }>(config.entity, scope);

  const detach = useSharedDetach<ScopedResource>({
    resourceType: config.resourceType,
    scope,
    mutate,
  });

  // Attach, detach, and Promote a Shared resource are the same rule
  // (ADR-0007 / #154), asked of the auth module instead of re-derived here.
  const canAttach = canManageSharedResource(actor, workspaceId);

  // Workspace-scoped config is admin-only unless the workspace delegates it
  // (ADR-0006), resolved once by the auth module off the Workspace's own
  // delegation flags — no separate fetch needed. Org-level management lives
  // behind an admin-only route, so it is always manageable here.
  const canManage = workspaceId
    ? canConfigureWorkspaceResource(
        actor,
        config.resourceType,
        workspaceDelegation?.[config.delegationFlag] === true,
      )
    : true;

  if (isLoading) {
    return <ListState variant="loading">Loading...</ListState>;
  }

  if (error) {
    return <ListError error={error} subject={config.labels.plural} />;
  }

  const resources: ScopedResource[] = data?.results ?? [];
  // When the caller can attach or create, fall through to the main render
  // (which offers those buttons) even if the workspace has no resources yet.
  if (!resources.length && workspaceId && !canAttach && !canManage) {
    const EmptyState = config.emptyState;
    return (
      <EmptyState orgId={orgId} workspaceId={workspaceId} canManage={false} />
    );
  }

  // The resource's own settings surface, with any trailing segment: a row's
  // detail page, or its create page.
  const orgSettingsRoot = orgRoutes(orgId).settings[config.settingsKey];
  const settingsRoot = workspaceId
    ? workspaceRoutes(orgId, workspaceId).settings[config.settingsKey]
    : orgSettingsRoot;
  const settingsHref = (segment: string) => `${settingsRoot}/${segment}`;

  return (
    <>
      <ul className="mb-4">
        {resources.map((resource) => {
          const isOrgScopedInWorkspace =
            workspaceId && resource.scope === "organization";

          const row = (
            <>
              <ItemContent>
                <div className="flex items-center gap-2">
                  <ItemTitle>{resource.name}</ItemTitle>
                  {resource.scope === "organization" && <OrganizationBadge />}
                </div>
              </ItemContent>
              <ItemActions>
                <Pencil className="size-4" />
              </ItemActions>
            </>
          );

          return (
            <li key={resource.id} className="mb-2">
              {isOrgScopedInWorkspace ? (
                <Item
                  variant="outline"
                  onClick={() => detach.open(resource)}
                  className="cursor-pointer"
                >
                  {row}
                </Item>
              ) : (
                <Item variant="outline" asChild>
                  <Link href={settingsHref(resource.id)}>{row}</Link>
                </Item>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2">
        {canManage && (
          <Button asChild>
            <Link href={settingsHref("create")}>
              <Plus /> {config.labels.add}
            </Link>
          </Button>
        )}
        {canAttach && workspaceId && (
          <AttachSharedAction
            orgId={orgId}
            workspaceId={workspaceId}
            resourceType={config.resourceType}
            label={config.labels.attach}
            resources={resources}
            onAttached={mutate}
          />
        )}
      </div>
      <DetachSharedDialog
        detach={detach}
        title={config.labels.detachTitle}
        description={(selected) => (
          <>
            The {config.labels.noun} <strong>{selected.name}</strong> is managed
            at the organization level. It can only be edited from the
            organization settings.
          </>
        )}
        canDetach={canAttach}
        orgSettingsHref={(selected) => `${orgSettingsRoot}/${selected.id}`}
      />
    </>
  );
};

const OrganizationBadge = () => (
  <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-[10px] font-medium text-secondary-foreground uppercase tracking-wider">
    <Building className="size-3" />
    Organization
  </div>
);
