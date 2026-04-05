"use client";

import { type MessagingChannel } from "@platypus/schemas";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import useSWR from "swr";
import { cn, fetcher, joinUrl } from "../lib/utils";
import { useAuth } from "@/components/auth-provider";
import { Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";

const MessagingChannelsList = ({
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

  const fetchUrl =
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/messaging/channels`,
        )
      : null;

  const { data, error, isLoading } = useSWR<{ results: MessagingChannel[] }>(
    fetchUrl,
    fetcher,
  );

  if (isLoading || error) return null;

  const channels: MessagingChannel[] = data?.results ?? [];

  return (
    <>
      <ul className={cn("mb-4", className)}>
        {channels.map((channel) => (
          <li key={channel.id} className="mb-2">
            <Item variant="outline">
              <ItemContent>
                <ItemTitle className="flex items-center gap-2">
                  {channel.type.charAt(0).toUpperCase() + channel.type.slice(1)}
                  <Badge variant={channel.enabled ? "default" : "secondary"}>
                    {channel.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Link
                  href={`/${orgId}/workspace/${workspaceId}/settings/messaging/${channel.id}`}
                >
                  <Button variant="outline" size="sm">
                    <Pencil /> Edit
                  </Button>
                </Link>
              </ItemActions>
            </Item>
          </li>
        ))}
      </ul>

      {channels.length === 0 && (
        <Link
          href={`/${orgId}/workspace/${workspaceId}/settings/messaging/create`}
        >
          <Button>
            <Plus /> Add Channel
          </Button>
        </Link>
      )}
    </>
  );
};

export { MessagingChannelsList };
