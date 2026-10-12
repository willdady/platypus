"use client";

import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { Pencil, Plus, Radio } from "lucide-react";
import Link from "next/link";
import { Button } from "./ui/button";
import { EmptyCard } from "@/components/empty-card";

import { workspaceRoutes } from "@/lib/routes";
import {
  ButtonSkeleton,
  ItemRowsSkeleton,
  LoadingRegion,
} from "./list-skeletons";

interface Webhook {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  enabled: boolean;
}

const WebhooksList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const routes = workspaceRoutes(orgId, workspaceId);

  const { data, error, isLoading } = useScopedSWR<{ results: Webhook[] }>(
    "webhooks",
    { orgId, workspaceId },
  );

  if (isLoading) {
    return (
      <LoadingRegion label="Loading webhooks">
        <ItemRowsSkeleton rows={2} secondLine />
        <ButtonSkeleton className="w-36" />
      </LoadingRegion>
    );
  }
  if (error) return <div>Failed to load webhooks.</div>;

  const webhooks: Webhook[] = data?.results ?? [];

  if (!webhooks.length) {
    return (
      <EmptyCard
        icon={<Radio />}
        title="No webhooks configured"
        description="Add a webhook to deliver this workspace's events to a URL you control."
        action={
          <Button asChild>
            <Link href={routes.settings.createWebhook}>
              <Plus /> Add webhook
            </Link>
          </Button>
        }
      />
    );
  }

  return (
    <>
      <ul className="mb-4">
        {webhooks.map((webhook) => (
          <li key={webhook.id} className="mb-2">
            <Item variant="outline" asChild>
              <Link href={routes.settings.webhookDetail(webhook.id)}>
                <ItemContent>
                  <div className="flex items-center gap-2">
                    <ItemTitle>{webhook.name}</ItemTitle>
                    {!webhook.enabled && (
                      <span className="px-2 py-0.5 rounded-full bg-secondary text-[10px] font-medium text-secondary-foreground uppercase tracking-wider">
                        Disabled
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground truncate">
                    {webhook.url}
                  </p>
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
        <Link href={routes.settings.createWebhook}>
          <Plus /> Add webhook
        </Link>
      </Button>
    </>
  );
};

export { WebhooksList };
