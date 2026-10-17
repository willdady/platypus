"use client";

import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { Plus, Radio } from "lucide-react";
import Link from "next/link";
import { Button } from "./ui/button";
import { EmptyCard } from "@/components/empty-card";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DisabledBadge } from "@/components/disabled-badge";
import { RowActionsMenu } from "@/components/row-actions-menu";
import { writeEntity } from "@/lib/api-write";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { useEnabledToggle } from "@/hooks/use-enabled-toggle";

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

  const scope = { orgId, workspaceId };
  const { data, error, isLoading, mutate } = useScopedSWR<{
    results: Webhook[];
  }>("webhooks", scope);

  const deleteFlow = useDeleteFlow<Webhook>({
    mutate,
    delete: (webhook, url) =>
      writeEntity(url, "webhooks", scope, { id: webhook.id }),
  });
  const toggle = useEnabledToggle<Webhook>({
    entity: "webhooks",
    scope,
    mutate,
  });

  if (isLoading) {
    return (
      <LoadingRegion label="Loading webhooks">
        <ItemRowsSkeleton rows={2} secondLine />
        <ButtonSkeleton className="w-36" />
      </LoadingRegion>
    );
  }
  if (error) return <div>Failed to load webhooks.</div>;

  const webhooks: Webhook[] = toggle.apply(data?.results ?? []);

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
                    {!webhook.enabled && <DisabledBadge />}
                  </div>
                  <p
                    className="text-sm text-muted-foreground truncate"
                    title={webhook.url}
                  >
                    {webhook.url}
                  </p>
                </ItemContent>
                <ItemActions>
                  <RowActionsMenu
                    name={webhook.name}
                    edit={{ href: routes.settings.webhookDetail(webhook.id) }}
                    toggle={{
                      enabled: webhook.enabled,
                      onSelect: () => void toggle.toggle(webhook),
                      disabled: toggle.isToggling(webhook.id),
                    }}
                    remove={{
                      onSelect: () => deleteFlow.request(webhook),
                    }}
                  />
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
      <DeleteConfirmDialog
        open={deleteFlow.open}
        onOpenChange={(open) => !open && deleteFlow.close()}
        title="Delete webhook"
        description={`Are you sure you want to delete "${deleteFlow.target?.name}"? This action cannot be undone.`}
        onConfirm={deleteFlow.confirm}
        loading={deleteFlow.deleting}
        error={deleteFlow.error}
      />
    </>
  );
};

export { WebhooksList };
