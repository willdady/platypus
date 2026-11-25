"use client";

import { type ComponentType, type ReactNode, useState } from "react";
import { Plus, Share2 } from "lucide-react";
import Link from "next/link";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useAuth } from "@/components/auth-provider";
import {
  canManageOrgSharedResource,
  canManageSharedResource,
  type DelegatableResourceType,
} from "@/lib/authorization";
import { useCanConfigureWorkspaceResource } from "@/hooks/use-can-configure-workspace-resource";
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
import { ListFooter } from "./list-pagination";
import {
  AttachSharedAction,
  DeleteBlockedDialog,
  DetachSharedDialog,
} from "./shared-resource-actions";

type ScopedResource = {
  readonly id: string;
  readonly name: string;
  readonly scope?: "organization" | "workspace";
  readonly providerType?: string;
  readonly url?: string;
};

type EmptyStateProps = {
  readonly orgId: string;
  readonly workspaceId?: string;
  readonly canManage: boolean;
  readonly action?: ReactNode;
};

export type ResourceListLabels = {
  readonly add: string;
  readonly attach: string;
  readonly noun: string;
  readonly plural: string;
};

export type ResourceListConfig = {
  readonly entity: string;
  readonly resourceType: DelegatableResourceType;
  readonly settingsKey: "providers" | "mcp";
  readonly labels: ResourceListLabels;
  readonly secondLine: "providerType" | "url";
  readonly emptyState: ComponentType<EmptyStateProps>;
};

export function ResourceList({
  orgId,
  workspaceId,
  config,
}: {
  orgId: string;
  workspaceId?: string;
  config: ResourceListConfig;
}) {
  const { actor } = useAuth();
  const canConfigureInWorkspace = useCanConfigureWorkspaceResource(
    config.resourceType,
  );
  const [resourceToManage, setResourceToManage] =
    useState<ScopedResource | null>(null);

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

  const deleteGuard = useSharedDeleteGuard<ScopedResource>({
    resourceType: config.resourceType,
    scope,
    onAllowed: deleteFlow.request,
  });

  const canAttach = canManageSharedResource(actor, workspaceId);
  const canManageAttachments =
    !workspaceId && canManageOrgSharedResource(actor);

  const canManage = workspaceId ? canConfigureInWorkspace : true;

  const orgSettingsRoot = orgRoutes(orgId).settings[config.settingsKey];
  const settingsRoot = workspaceId
    ? workspaceRoutes(orgId, workspaceId).settings[config.settingsKey]
    : orgSettingsRoot;
  const settingsHref = (segment: string) => `${settingsRoot}/${segment}`;

  const actions = (
    <>
      {canManage && (
        <Button variant={resources.length ? "outline" : "default"} asChild>
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
    </>
  );

  const EmptyState = config.emptyState;

  const cards = resources.map((resource) => ({
    ...resource,
    description: resource[config.secondLine],
  }));

  const isShared = (resource: ScopedResource) =>
    Boolean(workspaceId) && resource.scope === "organization";

  return (
    <>
      <EntityCardList
        singleColumn
        items={cards}
        isLoading={isLoading}
        error={error}
        data={data}
        subject={config.labels.plural}
        onRetry={() => void mutate()}
        skeleton={
          <>
            <CardGridSkeleton
              singleColumn
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
                remove={{ onSelect: () => detach.request(resource) }}
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
      {resources.length > 0 && (
        <ListFooter className="mt-4">{actions}</ListFooter>
      )}
      <ManageAttachmentsDialog
        orgId={orgId}
        resourceType={config.resourceType}
        resource={resourceToManage}
        onClose={() => setResourceToManage(null)}
      />
      <DetachSharedDialog
        detach={detach}
        noun={config.labels.noun}
        canDetach={canAttach}
        orgSettingsHref={(selected) => `${orgSettingsRoot}/${selected.id}`}
      />
      <DeleteConfirmDialog
        noun={config.labels.noun}
        name={deleteFlow.target?.name}
        {...deleteFlow.dialogProps}
      />
      <DeleteBlockedDialog
        guard={deleteGuard}
        noun={config.labels.noun}
        onManage={setResourceToManage}
      />
    </>
  );
}
