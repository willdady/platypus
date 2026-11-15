"use client";

import { Plus, Radio } from "lucide-react";
import Link from "next/link";
import { Button } from "./ui/button";
import { EmptyCard } from "@/components/empty-card";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DisabledBadge } from "@/components/disabled-badge";
import { EntityCardList } from "@/components/entity-card-list";
import { RowActionsMenu } from "@/components/row-actions-menu";
import { writeEntity } from "@/lib/api-write";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { useEnabledToggle } from "@/hooks/use-enabled-toggle";
import { useScopedList } from "@/hooks/use-scoped-list";
import { ListFooter } from "@/components/list-pagination";

import { workspaceRoutes } from "@/lib/routes";
import { ButtonRowSkeleton, CardGridSkeleton } from "./list-skeletons";

type Webhook = {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  enabled: boolean;
};

function WebhooksList({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const routes = workspaceRoutes(orgId, workspaceId);

  const scope = { orgId, workspaceId };
  const { data, results, error, isLoading, mutate } = useScopedList<Webhook>(
    "webhooks",
    scope,
  );

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

  const webhooks = toggle.apply(results);

  const actions = (
    <Button variant={webhooks.length ? "outline" : "default"} asChild>
      <Link href={routes.settings.createWebhook}>
        <Plus /> Add webhook
      </Link>
    </Button>
  );

  return (
    <>
      <EntityCardList
        singleColumn
        items={webhooks.map((webhook) => ({
          ...webhook,
          description: webhook.url,
        }))}
        isLoading={isLoading}
        error={error}
        data={data}
        subject="webhooks"
        onRetry={() => void mutate()}
        skeleton={
          <>
            <CardGridSkeleton singleColumn descriptionLines={1} />
            <ButtonRowSkeleton className="mt-4" widths={["w-36"]} />
          </>
        }
        empty={
          <EmptyCard
            icon={<Radio />}
            title="No webhooks configured"
            description="Add a webhook to deliver this workspace's events to a URL you control."
            action={actions}
          />
        }
        // The URL is the card's second line and nothing follows it.
        descriptionLines={1}
        href={(webhook) => routes.settings.webhookDetail(webhook.id)}
        badges={(webhook) => !webhook.enabled && <DisabledBadge />}
        menu={(webhook) => (
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
        )}
      />

      {webhooks.length > 0 && (
        <ListFooter className="mt-4">{actions}</ListFooter>
      )}

      <DeleteConfirmDialog
        noun="webhook"
        name={deleteFlow.target?.name}
        {...deleteFlow.dialogProps}
      />
    </>
  );
}

export { WebhooksList };
