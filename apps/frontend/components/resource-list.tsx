"use client";

import { type ComponentType, useState } from "react";
import {
  Building,
  ExternalLink,
  Link2,
  Pencil,
  Plus,
  Unlink,
} from "lucide-react";
import Link from "next/link";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import {
  canConfigureWorkspaceResource,
  canManageSharedResource,
  type DelegatableResourceType,
  type WorkspaceDelegationFlags,
} from "@/lib/authorization";
import { writeEntity, type Scope } from "@/lib/api-write";
import { useDetachDialog } from "@/hooks/use-detach-dialog";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { AttachSharedResourceDialog } from "./attach-shared-resource-dialog";

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
  /** Settings route for the resource's own pages: "settings/providers" / "settings/mcp". */
  readonly settingsPath: string;
  /** The Workspace delegation flag granting self-management (ADR-0006). */
  readonly delegationFlag: keyof WorkspaceDelegationFlags;
  readonly labels: ResourceListLabels;
  /** Rendered when a workspace has no resources and the caller cannot attach one. */
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
  const backendUrl = useBackendUrl();
  const detach = useDetachDialog<ScopedResource>();
  const [attachOpen, setAttachOpen] = useState(false);
  const [detaching, setDetaching] = useState(false);

  // Resolved once per render and reused for the list's read and every write
  // below, rather than re-deriving the Organization-vs-Workspace branch at
  // each call site.
  const scope: Scope = workspaceId ? { orgId, workspaceId } : { orgId };

  const { data, error, isLoading, mutate } = useScopedSWR<{
    results: ScopedResource[];
  }>(config.entity, scope);

  // Attach, detach, and Promote a Shared resource are the same rule
  // (ADR-0007 / #154), asked of the auth module instead of re-derived here.
  const canAttach = canManageSharedResource(actor, workspaceId).allowed;

  const detachResource = async (resourceId: string) => {
    if (!backendUrl || !workspaceId) return;
    setDetaching(true);
    detach.setError(null);
    try {
      const outcome = await writeEntity(
        backendUrl,
        `attachments/${config.resourceType}`,
        scope,
        { id: resourceId },
      );
      if (outcome.outcome === "success") {
        detach.close();
        await mutate();
      } else {
        detach.setError(outcome.message);
      }
    } finally {
      setDetaching(false);
    }
  };

  // Workspace-scoped config is admin-only unless the workspace delegates it
  // (ADR-0006), resolved once by the auth module off the Workspace's own
  // delegation flags — no separate fetch needed. Org-level management lives
  // behind an admin-only route, so it is always manageable here.
  const canManage = workspaceId
    ? canConfigureWorkspaceResource(
        actor,
        config.resourceType,
        workspaceDelegation?.[config.delegationFlag] === true,
      ).allowed
    : true;

  if (isLoading) {
    return null;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-destructive">
          Failed to load {config.labels.plural}.{" "}
          {error.info?.message || error.message}
        </p>
      </div>
    );
  }

  const resources: ScopedResource[] = data?.results ?? [];
  const attachedOrgIds = resources
    .filter((resource) => resource.scope === "organization")
    .map((resource) => resource.id);
  // When an admin can attach Shared resources, fall through to the main render
  // (which offers the Attach button) even if the workspace has no resources yet.
  if (!resources.length && workspaceId && !canAttach) {
    const EmptyState = config.emptyState;
    return (
      <EmptyState
        orgId={orgId}
        workspaceId={workspaceId}
        canManage={canManage}
      />
    );
  }

  // The resource's own settings surface, with any trailing segment: a row's
  // detail page, or its create page.
  const settingsHref = (segment: string) =>
    `${
      workspaceId
        ? `/${orgId}/workspace/${workspaceId}/${config.settingsPath}`
        : `/${orgId}/${config.settingsPath}`
    }/${segment}`;

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
        {canAttach && (
          <Button variant="outline" onClick={() => setAttachOpen(true)}>
            <Link2 className="size-4" /> {config.labels.attach}
          </Button>
        )}
      </div>
      {canAttach && workspaceId && (
        <AttachSharedResourceDialog
          open={attachOpen}
          onOpenChange={setAttachOpen}
          orgId={orgId}
          workspaceId={workspaceId}
          resourceType={config.resourceType}
          attachedIds={attachedOrgIds}
          onAttached={() => {
            setAttachOpen(false);
            mutate();
          }}
        />
      )}
      <Dialog
        open={!!detach.selected}
        onOpenChange={(open) => {
          if (!open) detach.close();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{config.labels.detachTitle}</DialogTitle>
            <DialogDescription>
              The {config.labels.noun} <strong>{detach.selected?.name}</strong>{" "}
              is managed at the organization level. It can only be edited from
              the organization settings.
            </DialogDescription>
          </DialogHeader>
          {detach.error && (
            <p className="text-sm text-destructive">{detach.error}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={detach.close}>
              Close
            </Button>
            {canAttach && detach.selected && (
              <Button
                variant="destructive"
                disabled={detaching}
                onClick={() => detachResource(detach.selected!.id)}
              >
                <Unlink className="size-4" />
                Detach
              </Button>
            )}
            {canAttach && (
              <Button asChild>
                {/* The Org settings copy, even from a workspace: that is where
                    the Shared resource is edited. */}
                <Link
                  href={`/${orgId}/${config.settingsPath}/${detach.selected?.id}`}
                >
                  <ExternalLink className="size-4" />
                  Org settings
                </Link>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

const OrganizationBadge = () => (
  <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-[10px] font-medium text-secondary-foreground uppercase tracking-wider">
    <Building className="size-3" />
    Organization
  </div>
);
