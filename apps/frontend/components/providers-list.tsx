"use client";

import { Provider } from "@platypus/schemas";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import useSWR from "swr";
import { cn, fetcher, joinUrl } from "../lib/utils";
import { useAuth } from "@/components/auth-provider";
import { Building, ExternalLink, Pencil, Plus } from "lucide-react";
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
  type ProviderWithScope = Provider & { scope: "organisation" | "workspace" };

  const { user, isOrgAdmin } = useAuth();
  const backendUrl = useBackendUrl();
  const [selectedOrgProvider, setSelectedOrgProvider] =
    useState<ProviderWithScope | null>(null);

  const fetchUrl =
    backendUrl && user
      ? workspaceId
        ? joinUrl(
            backendUrl,
            `/organisations/${orgId}/workspaces/${workspaceId}/providers`,
          )
        : joinUrl(backendUrl, `/organisations/${orgId}/providers`)
      : null;

  const { data, error, isLoading } = useSWR<{ results: ProviderWithScope[] }>(
    fetchUrl,
    fetcher,
  );

  if (isLoading || error) return null; // FIXME

  const providers: ProviderWithScope[] = data?.results ?? [];
  if (!providers.length && workspaceId) {
    return <NoProvidersEmptyState orgId={orgId} workspaceId={workspaceId} />;
  }

  return (
    <>
      <ul className={cn("mb-4", className)}>
        {providers.map((provider) => {
          const isOrgScopedInWorkspace =
            workspaceId && provider.scope === "organisation";

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
                          Organisation
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
                        {provider.scope === "organisation" && (
                          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-[10px] font-medium text-secondary-foreground uppercase tracking-wider">
                            <Building className="size-3" />
                            Organisation
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
      <Dialog
        open={!!selectedOrgProvider}
        onOpenChange={(open) => !open && setSelectedOrgProvider(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Organisation Provider</DialogTitle>
            <DialogDescription>
              The provider <strong>{selectedOrgProvider?.name}</strong> is
              managed at the organisation level. It can only be edited from the
              organisation settings.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSelectedOrgProvider(null)}
            >
              Close
            </Button>
            {isOrgAdmin && (
              <Button asChild>
                <Link
                  href={`/${orgId}/settings/providers/${selectedOrgProvider?.id}`}
                >
                  <ExternalLink className="size-4" />
                  Go to Organisation Settings
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
