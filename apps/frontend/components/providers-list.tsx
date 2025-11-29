"use client";

import { Provider } from "@agent-kit/schemas";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import useSWR from "swr";
import { cn, fetcher } from "../lib/utils";
import { Pencil, Plus, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { useBackendUrl } from "@/app/client-context";
import { Button } from "./ui/button";

const ProvidersList = ({
  className,
  orgId,
  workspaceId,
}: {
  className?: string;
  orgId: string;
  workspaceId: string;
}) => {
  const backendUrl = useBackendUrl();

  const { data, error, isLoading } = useSWR<{ results: Provider[] }>(
    `${backendUrl}/providers?workspaceId=${workspaceId}`,
    fetcher,
  );

  if (isLoading || error) return null; // FIXME

  const providers: Provider[] = data?.results ?? [];
  if (!providers.length) {
    return (
      <Alert className="w-full mb-4">
        <TriangleAlert />
        <AlertTitle>No AI providers configured</AlertTitle>
        <AlertDescription>
          <p className="mb-2">You must configure at least one AI provider.</p>
          <Button size="sm" asChild>
            <Link
              href={`/${orgId}/workspace/${workspaceId}/settings/providers/create`}
            >
              <Plus /> Create your first provider
            </Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
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
  );
};

export { ProvidersList };
