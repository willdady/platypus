"use client";

import { Provider } from "@agent-kit/schemas";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import useSWR from "swr";
import { cn, fetcher } from "../lib/utils";
import { Pencil } from "lucide-react";
import Link from "next/link";

const ProvidersList = ({
  className,
  orgId,
  workspaceId,
}: {
  className?: string;
  orgId: string;
  workspaceId: string;
}) => {
  const { data, error, isLoading } = useSWR<{ results: Provider[] }>(
    `${process.env.NEXT_PUBLIC_BACKEND_URL}/providers`,
    fetcher,
  );

  if (isLoading || error) return null; // FIXME

  return (
    <ul className={cn("mb-4", className)}>
      {data?.results.map((provider) => (
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
