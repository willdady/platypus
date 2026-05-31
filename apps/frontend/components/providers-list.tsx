"use client";

import { Provider, type Workspace } from "@platypus/schemas";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import useSWR from "swr";
import { cn, fetcher, joinUrl } from "../lib/utils";
import { useAuth } from "@/components/auth-provider";
import {
  Building,
  ExternalLink,
  Link2,
  Pencil,
  Plus,
  Unlink,
} from "lucide-react";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { Button } from "./ui/button";
import { NoProvidersEmptyState } from "./no-providers-empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { AttachSharedResourceDialog } from "./attach-shared-resource-dialog";
import { useState } from "react";

const ProvidersList = ({
  className,
  orgId,
  workspaceId,
}: {
  className?: string;
  orgId: string;
  workspaceId?: string;
}) => {
  // Add scope to Provider type for this component
  type ProviderWithScope = Provider & { scope: "organization" | "workspace" };

  const { user, isOrgAdmin } = useAuth();
  const backendUrl = useBackendUrl();
  const [selectedOrgProvider, setSelectedOrgProvider] =
    useState<ProviderWithScope | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [detaching, setDetaching] = useState(false);

  const fetchUrl =
    backendUrl && user
      ? workspaceId
        ? joinUrl(
            backendUrl,
            `/organizations/${orgId}/workspaces/${workspaceId}/providers`,
          )
        : joinUrl(backendUrl, `/organizations/${orgId}/providers`)
      : null;

  const { data, error, isLoading, mutate } = useSWR<{
    results: ProviderWithScope[];
  }>(fetchUrl, fetcher);

  // Attaching/detaching org-scoped Shared resources is an Org Admin action,
  // available only inside a workspace (ADR-0007 / #154).
  const canAttach = Boolean(workspaceId) && isOrgAdmin;

  const detachOrgProvider = async (providerId: string) => {
    if (!backendUrl || !workspaceId) return;
    setDetaching(true);
    try {
      await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/attachments/provider/${providerId}`,
        ),
        { method: "DELETE", credentials: "include" },
      );
      setSelectedOrgProvider(null);
      await mutate();
    } finally {
      setDetaching(false);
    }
  };

  // Workspace-scoped provider config is admin-only unless the workspace
  // delegates it (ADR-0006). Org-level provider management lives behind an
  // admin-only route, so it is always manageable here.
  const { data: workspace } = useSWR<Workspace>(
    backendUrl && user && workspaceId
      ? joinUrl(backendUrl, `/organizations/${orgId}/workspaces/${workspaceId}`)
      : null,
    fetcher,
  );
  const canManage = workspaceId
    ? isOrgAdmin || workspace?.providerSelfManagement === true
    : true;

  if (isLoading || error) return null; // FIXME

  const providers: ProviderWithScope[] = data?.results ?? [];
  const attachedOrgIds = providers
    .filter((p) => p.scope === "organization")
    .map((p) => p.id);
  // When an admin can attach Shared resources, fall through to the main render
  // (which offers the Attach button) even if the workspace has no providers yet.
  if (!providers.length && workspaceId && !canAttach) {
    return (
      <NoProvidersEmptyState
        orgId={orgId}
        workspaceId={workspaceId}
        canManage={canManage}
      />
    );
  }

  return (
    <>
      <ul className={cn("mb-4", className)}>
        {providers.map((provider) => {
          const isOrgScopedInWorkspace =
            workspaceId && provider.scope === "organization";

          return (
            <li key={provider.id} className="mb-2">
              <Item
                variant="outline"
                asChild={!isOrgScopedInWorkspace}
                onClick={
                  isOrgScopedInWorkspace
                    ? () => setSelectedOrgProvider(provider)
                    : undefined
                }
                className={cn(isOrgScopedInWorkspace && "cursor-pointer")}
              >
                {isOrgScopedInWorkspace ? (
                  <>
                    <ItemContent>
                      <div className="flex items-center gap-2">
                        <ItemTitle>{provider.name}</ItemTitle>
                        <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-[10px] font-medium text-secondary-foreground uppercase tracking-wider">
                          <Building className="size-3" />
                          Organization
                        </div>
                      </div>
                    </ItemContent>
                    <ItemActions>
                      <Pencil className="size-4" />
                    </ItemActions>
                  </>
                ) : (
                  <Link
                    href={
                      workspaceId
                        ? `/${orgId}/workspace/${workspaceId}/settings/providers/${provider.id}`
                        : `/${orgId}/settings/providers/${provider.id}`
                    }
                  >
                    <ItemContent>
                      <div className="flex items-center gap-2">
                        <ItemTitle>{provider.name}</ItemTitle>
                        {provider.scope === "organization" && (
                          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-[10px] font-medium text-secondary-foreground uppercase tracking-wider">
                            <Building className="size-3" />
                            Organization
                          </div>
                        )}
                      </div>
                    </ItemContent>
                    <ItemActions>
                      <Pencil className="size-4" />
                    </ItemActions>
                  </Link>
                )}
              </Item>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2">
        {canManage && (
          <Button asChild>
            <Link
              href={
                workspaceId
                  ? `/${orgId}/workspace/${workspaceId}/settings/providers/create`
                  : `/${orgId}/settings/providers/create`
              }
            >
              <Plus /> Add provider
            </Link>
          </Button>
        )}
        {canAttach && (
          <Button variant="outline" onClick={() => setAttachOpen(true)}>
            <Link2 className="size-4" /> Attach shared provider
          </Button>
        )}
      </div>
      {canAttach && workspaceId && (
        <AttachSharedResourceDialog
          open={attachOpen}
          onOpenChange={setAttachOpen}
          orgId={orgId}
          workspaceId={workspaceId}
          resourceType="provider"
          attachedIds={attachedOrgIds}
          onAttached={() => {
            setAttachOpen(false);
            mutate();
          }}
        />
      )}
      <Dialog
        open={!!selectedOrgProvider}
        onOpenChange={(open) => !open && setSelectedOrgProvider(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Organization Provider</DialogTitle>
            <DialogDescription>
              The provider <strong>{selectedOrgProvider?.name}</strong> is
              managed at the organization level. It can only be edited from the
              organization settings.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSelectedOrgProvider(null)}
            >
              Close
            </Button>
            {canAttach && selectedOrgProvider && (
              <Button
                variant="destructive"
                disabled={detaching}
                onClick={() => detachOrgProvider(selectedOrgProvider.id)}
              >
                <Unlink className="size-4" />
                Detach
              </Button>
            )}
            {isOrgAdmin && (
              <Button asChild>
                <Link
                  href={`/${orgId}/settings/providers/${selectedOrgProvider?.id}`}
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

export { ProvidersList };
