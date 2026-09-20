"use client";

import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { Button } from "./ui/button";
import { workspaceRoutes } from "@/lib/routes";

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

  if (isLoading) return null;
  if (error) return <div>Failed to load webhooks.</div>;

  const webhooks: Webhook[] = data?.results ?? [];

  if (!webhooks.length) {
    return (
      <div>
        <p className="text-muted-foreground mb-4">
          No webhooks configured for this workspace.
        </p>
        <Button asChild>
          <Link href={routes.settings.createWebhook}>
            <Plus /> Add webhook
          </Link>
        </Button>
      </div>
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
