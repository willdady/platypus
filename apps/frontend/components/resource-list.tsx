"use client";

import { type ComponentType, type ReactNode, useState } from "react";
import { Plus, Share2 } from "lucide-react";
import Link from "next/link";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useAuth } from "@/components/auth-provider";
import {
  canConfigureWorkspaceResource,
  canManageOrgSharedResource,
  canManageSharedResource,
  type DelegatableResourceType,
  type WorkspaceDelegationFlags,
} from "@/lib/authorization";
import { writeEntity, type Scope } from "@/lib/api-write";
import { orgRoutes, workspaceRoutes } from "@/lib/routes";
import {
  useSharedDeleteGuard,
  useSharedDetach,
} from "@/hooks/use-shared-resource-actions";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import {
  ButtonRowSkeleton,
  CardGridSkeleton,
  SkeletonLine,
} from "./list-skeletons";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";
import { EntityCardList } from "./entity-card-list";
import { OrganizationBadge } from "./organization-badge";
import {
  AttachmentCount,
  ManageAttachmentsDialog,
  SharedWithBadge,
  UnattachedWarning,
} from "./manage-sharing";
import { RowActionsMenu } from "./row-actions-menu";
import { Button } from "./ui/button";
import {
  AttachSharedAction,
  DeleteBlockedDialog,
  DetachSharedDialog,
} from "./shared-resource-actions";

/** A list row as the API returns it: an id, a name, and — inside a workspace — its scope. */
type ScopedResource = {
  readonly id: string;
  readonly name: string;
  readonly scope?: "organization" | "workspace";
  /** A Provider's type. */
  readonly providerType?: string;
  /** An MCP server's URL. */
  readonly url?: string;
};

type EmptyStateProps = {
  readonly orgId: string;
  readonly workspaceId?: string;
  readonly canManage: boolean;
  readonly action?: ReactNode;
};

export type ResourceListLabels = {
  /** Create CTA: "Add provider" / "Add MCP server". */
  readonly add: string;
  /** Attach CTA: "Attach shared provider" / "Attach shared MCP". */
  readonly attach: string;
  /** Detach dialog title: "Detach shared provider" / "Detach shared MCP server". */
  readonly detachTitle: string;
  /** Delete dialog title: "Delete Provider" / "Delete MCP server". */
  readonly deleteTitle: string;
  /** The resource named mid-sentence: "provider" / "MCP server". */
  readonly noun: string;
  /** The resource named in a fetch failure: "providers" / "MCP servers". */
  readonly plural: string;
};

export type ResourceListConfig = {
  /** Collection entity as the API spells it: "providers" / "mcps". */
  readonly entity: string;
  /** Which Shared resource this is — names the attach/detach endpoints (ADR-0007). */
  readonly resourceType: DelegatableResourceType;
  /** Which settings route the resource's own pages live under (`lib/routes`). */
  readonly settingsKey: "providers" | "mcp";
  /** The Workspace delegation flag granting self-management (ADR-0006). */
  readonly delegationFlag: keyof WorkspaceDelegationFlags;
  readonly labels: ResourceListLabels;
  /** The row field shown on the card's second line: a Provider's type, an MCP server's URL. */
  readonly secondLine: "providerType" | "url";
  /** Rendered when the list has no resources, holding whichever Add / Attach buttons the caller gets. */
  readonly emptyState: ComponentType<EmptyStateProps>;
};

/**
 * The Organization-or-Workspace list of a Scoped resource (ADR-0007), one
 * component for providers and MCP servers. The resource nouns, labels, route,
 * delegation flag, and empty state are the parameters; everything else — the
 * read, the org-scoped lock, attach, detach, and the fetch-error state — is
 * shared, so the two resources cannot drift apart again.
 */
export function ResourceList({
  orgId,
  workspaceId,
  config,
}: {
  orgId: string;
  workspaceId?: string;
  config: ResourceListConfig;
}) {
  const { actor, workspaceDelegation } = useAuth();
  const [resourceToManage, setResourceToManage] =
    useState<ScopedResource | null>(null);

  // Resolved once per render and reused for the list's read and every write
  // below, rather than re-deriving the Organization-vs-Workspace branch at
  // each call site.
  const scope: Scope = workspaceId ? { orgId, workspaceId } : { orgId };

  const {
    data,
    error,
    isLoading,
    mutate,
    results: resources,
  } = useScopedList<ScopedResource>(config.entity, scope);

  const detach = useSharedDetach<ScopedResource>({
    resourceType: config.resourceType,
    scope,
    mutate,
  });

  const deleteFlow = useDeleteFlow<ScopedResource>({
    mutate,
    guidanceOnForbidden: true,
    delete: (resource, url) =>
      writeEntity(url, config.entity, scope, { id: resource.id }),
  });

  // On the Organization surface a Shared resource can't be deleted while
  // attached (ADR-0007); the guard explains the blocker up front instead of
  // sending a delete the backend is guaranteed to refuse. Inside a Workspace
  // there is nothing to check — the row is either private or a locked card.
  const deleteGuard = useSharedDeleteGuard<ScopedResource>({
    resourceType: config.resourceType,
    scope,
    onAllowed: deleteFlow.request,
  });

  // Attach, detach, and Promote a Shared resource are the same rule
  // (ADR-0007 / #154), asked of the auth module instead of re-derived here.
  const canAttach = canManageSharedResource(actor, workspaceId);
  // Where an org-scoped resource is attached is managed from the Organization
  // surface only, by an Org Admin — as for Skills and Agents.
  const canManageAttachments =
    !workspaceId && canManageOrgSharedResource(actor);

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

  // The resource's own settings surface, with any trailing segment: a row's
  // detail page, or its create page.
  const orgSettingsRoot = orgRoutes(orgId).settings[config.settingsKey];
  const settingsRoot = workspaceId
    ? workspaceRoutes(orgId, workspaceId).settings[config.settingsKey]
    : orgSettingsRoot;
  const settingsHref = (segment: string) => `${settingsRoot}/${segment}`;

  const actions = (
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
  );

  const EmptyState = config.emptyState;

  // The card's description carries the row's second line: a Provider's type,
  // an MCP server's URL.
  const cards = resources.map((resource) => ({
    ...resource,
    description: resource[config.secondLine],
  }));

  // A Shared resource is locked inside a Workspace: a plain card, with Detach
  // named in its menu rather than behind the card's own click (ADR-0007).
  const isShared = (resource: ScopedResource) =>
    Boolean(workspaceId) && resource.scope === "organization";

  return (
    <>
      <EntityCardList
        items={cards}
        isLoading={isLoading}
        error={error}
        subject={config.labels.plural}
        onRetry={() => void mutate()}
        skeleton={
          // The same cards, then the same Add / Attach buttons the loaded
          // list offers this caller, so neither pops in when the read lands.
          <>
            <CardGridSkeleton
              titleBadges={workspaceId ? ["w-24"] : []}
              descriptionLines={1}
              extra={
                canManageAttachments && (
                  <SkeletonLine lineClassName="mt-1 h-4" className="h-3 w-24" />
                )
              }
            />
            <ButtonRowSkeleton
              className="mt-4"
              widths={[
                ...(canManage ? ["w-32"] : []),
                ...(canAttach && workspaceId ? ["w-48"] : []),
              ]}
            />
          </>
        }
        empty={
          <EmptyState
            orgId={orgId}
            workspaceId={workspaceId}
            canManage={canManage}
            action={canManage || canAttach ? actions : undefined}
          />
        }
        descriptionLines={1}
        href={(resource) => settingsHref(resource.id)}
        isShared={isShared}
        // On the Organization surface the row is not locked, but a Shared
        // resource still carries its badge.
        badges={(resource) =>
          !workspaceId &&
          resource.scope === "organization" && <OrganizationBadge />
        }
        meta={(resource) =>
          canManageAttachments && (
            <div className="mt-1">
              <SharedWithBadge
                orgId={orgId}
                resourceType={config.resourceType}
                resourceId={resource.id}
              />
            </div>
          )
        }
        menu={(resource) =>
          isShared(resource) ? (
            canAttach ? (
              <RowActionsMenu
                name={resource.name}
                shared
                edit={{ href: `${orgSettingsRoot}/${resource.id}` }}
                remove={{ onSelect: () => detach.open(resource) }}
              />
            ) : null
          ) : (
            <RowActionsMenu
              name={resource.name}
              edit={{ href: settingsHref(resource.id) }}
              actions={
                canManageAttachments
                  ? [
                      {
                        label: "Manage attachments",
                        icon: <Share2 />,
                        onSelect: () => setResourceToManage(resource),
                      },
                    ]
                  : undefined
              }
              remove={
                canManage
                  ? {
                      onSelect: () =>
                        workspaceId
                          ? deleteFlow.request(resource)
                          : void deleteGuard.request(resource),
                    }
                  : undefined
              }
            />
          )
        }
        wrap={(resource, card) => (
          <AttachmentCount
            orgId={canManageAttachments ? orgId : null}
            resourceType={config.resourceType}
            resourceId={resource.id}
          >
            {(count) =>
              card({
                className: count === 0 ? "border-warning" : undefined,
                meta: count === 0 && <UnattachedWarning />,
              })
            }
          </AttachmentCount>
        )}
      />
      {!isLoading && !error && resources.length > 0 && (
        <div className="mt-4">{actions}</div>
      )}
      {resourceToManage && (
        <ManageAttachmentsDialog
          orgId={orgId}
          resourceType={config.resourceType}
          resourceId={resourceToManage.id}
          resourceName={resourceToManage.name}
          open
          onOpenChange={(open) => !open && setResourceToManage(null)}
        />
      )}
      <DetachSharedDialog
        detach={detach}
        title={config.labels.detachTitle}
        description={(selected) => (
          <>
            Detach <strong>{selected.name}</strong> from this workspace? The
            shared {config.labels.noun} itself is not deleted; it just stops
            appearing here.
          </>
        )}
        canDetach={canAttach}
        orgSettingsHref={(selected) => `${orgSettingsRoot}/${selected.id}`}
      />
      <DeleteConfirmDialog
        open={deleteFlow.open}
        onOpenChange={(open) => !open && deleteFlow.close()}
        title={config.labels.deleteTitle}
        description={`Are you sure you want to delete "${deleteFlow.target?.name}"? This action cannot be undone.`}
        onConfirm={deleteFlow.confirm}
        loading={deleteFlow.deleting}
        error={deleteFlow.error}
      />
      <DeleteBlockedDialog
        guard={deleteGuard}
        noun={config.labels.noun}
        onManage={setResourceToManage}
      />
    </>
  );
}
