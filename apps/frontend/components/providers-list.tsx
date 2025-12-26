"use client";

import { Provider } from "@platypus/schemas";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import useSWR from "swr";
import { cn, fetcher, joinUrl } from "../lib/utils";
import { useAuth } from "@/components/auth-provider";
import { Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { Button } from "./ui/button";
import { NoProvidersEmptyState } from "./no-providers-empty-state";

const ProvidersList = ({
  className,
  orgId,
  workspaceId,
}: {
  className?: string;
  orgId: string;
  workspaceId: string;
}) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const { data, error, isLoading } = useSWR<{ results: Provider[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organisations/${orgId}/workspaces/${workspaceId}/providers`,
        )
      : null,
    fetcher,
  );

  if (isLoading || error) return null; // FIXME

  const providers: Provider[] = data?.results ?? [];
  if (!providers.length) {
    return <NoProvidersEmptyState orgId={orgId} workspaceId={workspaceId} />;
  }

  return (
    <>
      <ul className={cn("mb-4", className)}>
        {providers.map((provider) => (
          <li key={provider.id} className="mb-2">
            <Item variant="outline" asChild>
              <Link
                href={`/${orgId}/workspace/${workspaceId}/settings/providers/${provider.id}`}
              >
                <ItemContent>
                  <ItemTitle>{provider.name}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Pencil className="size-4" />
                </ItemActions>
              </Link>
            </Item>
          </li>
        ))}
      </ul>
      <Button asChild>
        <Link
          href={`/${orgId}/workspace/${workspaceId}/settings/providers/create`}
        >
          <Plus /> Add provider
        </Link>
      </Button>
    </>
  );
};

export { ProvidersList };
